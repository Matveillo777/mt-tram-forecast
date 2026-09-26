package ru.tramforecast.live;

import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLongArray;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.stereotype.Service;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.MappingIterator;
import tools.jackson.databind.json.JsonMapper;

import ru.tramforecast.ApiException;
import ru.tramforecast.data.Csv;
import ru.tramforecast.data.DataStore;

import static ru.tramforecast.data.DataStore.HOURS;

/**
 * Прием сырых валидаций: нормализация маршрута и времени, отбор успешных проходов
 * и счетчики посадок маршрут x дата x час. Счетчики без блокировок, пачка сначала
 * копится локально и потом одним проходом добавляется в общие массивы.
 */
@Service
public class IngestService {

    static final String ROUTE = "ngpt_route";
    static final String RESULT = "validation_result";
    static final String TIME = "tran_date_time";
    private static final int MAX_ERRORS = 5;

    public record Result(long accepted, long rejected, long boardings, List<String> errors) {
    }

    private final DataStore store;
    private final JsonMapper json;
    private final Map<Long, AtomicLongArray> counters = new ConcurrentHashMap<>();
    private final Counter acceptedMeter;
    private final Counter rejectedMeter;
    private final Counter boardingsMeter;
    private volatile Instant updatedAt = Instant.now();

    public IngestService(DataStore store, JsonMapper json, MeterRegistry meters) {
        this.store = store;
        this.json = json;
        this.acceptedMeter = meters.counter("tram.ingest.records", "result", "accepted");
        this.rejectedMeter = meters.counter("tram.ingest.records", "result", "rejected");
        this.boardingsMeter = meters.counter("tram.ingest.boardings");
    }

    /** CSV датасета: заголовок, разделитель ";", нужны колонки ngpt_route, validation_result, tran_date_time. */
    public Result csv(String body) {
        Iterator<String> lines = body.lines().iterator();
        if (!lines.hasNext() || body.isBlank()) {
            throw ApiException.badRequest("Пустое тело запроса: ожидается CSV с заголовком");
        }
        String headerLine = Csv.stripBom(lines.next());
        char sep = headerLine.indexOf(';') >= 0 ? ';' : ',';
        String[] header = Csv.split(headerLine, sep);
        int cRoute = column(header, ROUTE);
        int cResult = column(header, RESULT);
        int cTime = column(header, TIME);
        int need = Math.max(cRoute, Math.max(cResult, cTime));
        Batch batch = new Batch();
        int line = 1;
        while (lines.hasNext()) {
            String text = lines.next();
            line++;
            if (text.isBlank()) {
                continue;
            }
            String[] row = Csv.split(text, sep);
            if (row.length <= need) {
                batch.reject("строка " + line + ": ожидается " + header.length + " колонок, найдено " + row.length);
                continue;
            }
            batch.add("строка ", line, row[cRoute], row[cResult], row[cTime]);
        }
        return batch.commit();
    }

    /** JSON-массив объектов с полями датасета. */
    public Result json(String body) {
        if (body == null || body.isBlank()) {
            throw ApiException.badRequest("Пустое тело запроса: ожидается JSON-массив записей валидаций");
        }
        if (!body.stripLeading().startsWith("[")) {
            throw ApiException.badRequest("Ожидается JSON-массив записей валидаций");
        }
        Batch batch = new Batch();
        int i = 0;
        // читаем массив по одной записи, без дерева на весь документ
        try (MappingIterator<JsonNode> records = json.readerFor(JsonNode.class).readValues(body)) {
            while (records.hasNextValue()) {
                JsonNode node = records.nextValue();
                i++;
                if (!node.isObject()) {
                    batch.reject("запись " + i + ": ожидается объект");
                    continue;
                }
                batch.add("запись ", i, text(node.get(ROUTE)), text(node.get(RESULT)), text(node.get(TIME)));
            }
        } catch (JacksonException e) {
            throw ApiException.badRequest("Тело запроса не является корректным JSON (запись " + (i + 1) + "): "
                    + e.getOriginalMessage());
        }
        return batch.commit();
    }

    public Batch batch() {
        return new Batch();
    }

    /** Посадки маршрута по часам на дату, индекс route * 24 + hour; null - за дату ничего не приходило. */
    public AtomicLongArray counts(LocalDate date) {
        return counters.get(date.toEpochDay());
    }

    public void reset(LocalDate date) {
        counters.remove(date.toEpochDay());
        updatedAt = Instant.now();
    }

    public Instant updatedAt() {
        return updatedAt;
    }

    /** Номер маршрута из ngpt_route: "17 трамвай" -> 17. Автобусы и прочий транспорт отсекаем. */
    static int routeNumber(String raw) {
        if (raw == null) {
            return -1;
        }
        String s = raw.trim().toLowerCase(Locale.ROOT);
        int i = 0;
        while (i < s.length() && !Character.isDigit(s.charAt(i))) {
            i++;
        }
        int j = i;
        while (j < s.length() && Character.isDigit(s.charAt(j)) && j - i < 6) {
            j++;
        }
        if (i == j) {
            return -1;
        }
        String rest = (s.substring(0, i) + s.substring(j)).trim();
        if (!rest.isEmpty() && !rest.contains("трам")) {
            return -1;
        }
        return Integer.parseInt(s, i, j, 10);
    }

    /** Код результата: 1 - успешный проход. Понимает и текст из выгрузки АСКП ("Валидация прошла успешно..."). */
    static int resultCode(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (s.isEmpty()) {
            return Integer.MIN_VALUE;
        }
        try {
            return (int) Double.parseDouble(s);
        } catch (NumberFormatException e) {
            String low = s.toLowerCase(Locale.ROOT);
            return low.contains("успешно") ? 1 : low.startsWith("отказ") ? 0 : Integer.MIN_VALUE;
        }
    }

    /** Эпоха-день * 24 + час из "ГГГГ-ММ-ДД ЧЧ:ММ:СС" (допускается T и дробные секунды); -1 если не разобрать. */
    static long dayHour(String raw) {
        if (raw == null) {
            return -1;
        }
        String s = raw.trim();
        if (s.length() < 16 || (s.charAt(10) != ' ' && s.charAt(10) != 'T') || s.charAt(13) != ':') {
            return -1;
        }
        try {
            if (s.charAt(4) != '-' || s.charAt(7) != '-') {
                return -1;
            }
            long day = LocalDate.of(Integer.parseInt(s, 0, 4, 10), Integer.parseInt(s, 5, 7, 10),
                    Integer.parseInt(s, 8, 10, 10)).toEpochDay();
            int hour = Integer.parseInt(s, 11, 13, 10);
            int minute = Integer.parseInt(s, 14, 16, 10);
            if (hour < 0 || hour >= HOURS || minute < 0 || minute > 59) {
                return -1;
            }
            return day * HOURS + hour;
        } catch (RuntimeException e) {
            return -1;
        }
    }

    private static int column(String[] header, String name) {
        for (int i = 0; i < header.length; i++) {
            if (header[i].trim().equalsIgnoreCase(name)) {
                return i;
            }
        }
        throw ApiException.badRequest("В заголовке CSV нет колонки " + name
                + ". Нужны колонки " + ROUTE + ", " + RESULT + ", " + TIME + " с разделителем ';'");
    }

    private static String text(JsonNode v) {
        return v == null || v.isNull() || !v.isValueNode() ? null : v.asString();
    }

    /** Пачка записей: копится без синхронизации, в общие счетчики попадает в commit(). */
    public final class Batch {

        private final int routes = store.routes().length;
        private final Map<Long, long[]> perDay = new HashMap<>();
        private final List<String> errors = new ArrayList<>(MAX_ERRORS);
        private long accepted;
        private long rejected;
        private long boardings;

        /** where + n - место записи для текста ошибки, строка собирается только при отказе. */
        public void add(String where, long n, String route, String result, String time) {
            int number = routeNumber(route);
            if (number < 0) {
                reject(where + n + ": не удалось определить номер трамвайного маршрута из '" + route + "'");
                return;
            }
            int r = store.routeIdx(number);
            if (r < 0) {
                reject(where + n + ": маршрут " + number + " не входит в список маршрутов сервиса");
                return;
            }
            long dh = dayHour(time);
            if (dh < 0) {
                reject(where + n + ": время '" + time + "' не в формате ГГГГ-ММ-ДД ЧЧ:ММ:СС");
                return;
            }
            int code = resultCode(result);
            if (code == Integer.MIN_VALUE) {
                reject(where + n + ": validation_result '" + result + "' не является кодом результата");
                return;
            }
            accepted++;
            if (code == 1) {
                boardings++;
                perDay.computeIfAbsent(dh / HOURS, k -> new long[routes * HOURS])[r * HOURS + (int) (dh % HOURS)]++;
            }
        }

        void reject(String error) {
            rejected++;
            if (errors.size() < MAX_ERRORS) {
                errors.add(error);
            }
        }

        public Result commit() {
            for (Map.Entry<Long, long[]> e : perDay.entrySet()) {
                AtomicLongArray target = counters.computeIfAbsent(e.getKey(), k -> new AtomicLongArray(routes * HOURS));
                long[] add = e.getValue();
                for (int i = 0; i < add.length; i++) {
                    if (add[i] != 0) {
                        target.addAndGet(i, add[i]);
                    }
                }
            }
            if (accepted + rejected > 0) {
                updatedAt = Instant.now();
            }
            acceptedMeter.increment(accepted);
            rejectedMeter.increment(rejected);
            boardingsMeter.increment(boardings);
            return new Result(accepted, rejected, boardings, List.copyOf(errors));
        }
    }
}
