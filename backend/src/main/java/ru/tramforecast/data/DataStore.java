package ru.tramforecast.data;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * Все артефакты модели в памяти. Почасовые ряды лежат в плоских float-массивах,
 * поэтому агрегация за год - это один проход по массиву без аллокаций.
 * Любое расхождение с форматом останавливает запуск с понятным сообщением.
 */
@Component
public class DataStore {

    public static final int HOURS = 24;

    private static final Logger log = LoggerFactory.getLogger(DataStore.class);
    private static final Set<String> DAY_TYPES = Set.of("workday", "saturday", "sunday", "holiday");
    private static final Set<String> EVENT_DAYS = Set.of("all", "weekend", "workday");
    private static final Set<String> WEATHER_SOURCES = Set.of("observed", "climate");
    private static final String[] LIMIT_KEYS = {"temp_delta", "precip_mm", "snow_cm", "event_pct", "season_pct"};
    private static final double SHARE_TOLERANCE = 1e-3;

    /** shares: доля остановки в посадках маршрута по индексу stop * 24 + hour. */
    public record Route(int route, String name, String color, String[] stopIds,
                        Map<String, Integer> stopIndex, float[] shares, JsonNode json) {
    }

    /** Почасовая сетка маршрут x день x час, значение по индексу (route * days + day) * 24 + hour. */
    public record Grid(LocalDate from, int days, float[][] cols) {

        public LocalDate to() {
            return from.plusDays(days - 1L);
        }

        public boolean contains(LocalDate date) {
            return !date.isBefore(from) && !date.isAfter(to());
        }

        public int day(LocalDate date) {
            return (int) (date.toEpochDay() - from.toEpochDay());
        }

        public int index(int route, int day, int hour) {
            return (route * days + day) * HOURS + hour;
        }
    }

    /**
     * Погодные коэффициенты модели уровня дня (логарифмическая шкала) и границы поправок.
     * Признаки дня: дождь в будни при t >= rainWarmMinT, дождь в нерабочие дни, снег, жара выше heatAboveT,
     * мороз ниже coldBelowT.
     */
    public record Factors(double rainWarm, double rainWe, double snow, double heat, double cold,
                          double rainWarmMinT, double heatAboveT, double coldBelowT, Map<String, double[]> limits) {

        /** Сумма coef x признак для погоды дня; разность двух таких сумм - логарифм поправки. */
        public double weatherLog(double t, double rainMm, double snowCm, boolean nonWorking) {
            double rain = Math.log1p(rainMm);
            return (nonWorking ? rainWe * rain : t >= rainWarmMinT ? rainWarm * rain : 0)
                    + snow * Math.log1p(snowCm)
                    + heat * Math.max(t - heatAboveT, 0)
                    + cold * Math.max(coldBelowT - t, 0);
        }
    }

    /** Погода дня прогноза, от которой считаются поправки сценария: t_mean и осадки за 7-21 ч. */
    public record DayBase(double t, double rainMm, double snowCm, boolean nonWorking) {
    }

    public record CalendarDay(String date, String dayType, int isHoliday, int isPreholiday, int schoolBreak,
                              String note) {
    }

    public record WeatherDay(String date, Double tMean, Double precipMm, Double snowCm, Double rainDayMm,
                             Double snowDayCm, String source) {
    }

    public record Event(int route, String dateFrom, String dateTo, String days, double factor, String title,
                        String sourceUrl) {
    }

    private final JsonMapper json;
    private final LocalDate today;
    private final Route[] routes;
    private final int[] routeIndex;
    private final Grid forecast;
    private final Grid history;
    private final JsonNode routesJson;
    private final JsonNode factorsJson;
    private final JsonNode metricsJson;
    private final JsonNode geojson;
    private final Factors factors;
    private final List<CalendarDay> calendar;
    private final List<WeatherDay> weather;
    private final List<Event> events;
    private final DayBase[] forecastDays;

    public DataStore(@Value("${app.data-dir}") String dataDir, @Value("${app.today}") String today, JsonMapper json) {
        this.json = json;
        long started = System.nanoTime();
        Path dir = Path.of(dataDir);
        if (!Files.isDirectory(dir)) {
            throw new IllegalStateException("Каталог артефактов не найден: " + dir.toAbsolutePath()
                    + ". Укажите его в переменной DATA_DIR");
        }
        this.today = configDate("app.today", today);

        routesJson = readJson(dir, "routes.json");
        routes = loadRoutes(routesJson);
        int maxRoute = routes[routes.length - 1].route();
        routeIndex = new int[maxRoute + 1];
        Arrays.fill(routeIndex, -1);
        for (int i = 0; i < routes.length; i++) {
            routeIndex[routes[i].route()] = i;
        }

        forecast = loadGrid(dir, "forecast_hourly.csv", "p10", "p50", "p90");
        history = loadGrid(dir, "history_hourly.csv", "boardings");
        if (!forecast.contains(this.today)) {
            throw new IllegalStateException("app.today = " + this.today + " вне диапазона прогноза "
                    + forecast.from() + ".." + forecast.to());
        }
        loadShares(dir);

        factorsJson = readJson(dir, "factors.json");
        factors = loadFactors(factorsJson);
        metricsJson = readJson(dir, "metrics.json");
        for (String key : List.of("model", "backtests", "by_route", "external_effects")) {
            if (!metricsJson.has(key)) {
                throw fail("metrics.json", "нет обязательного ключа '" + key + "'");
            }
        }
        calendar = loadCalendar(dir);
        weather = loadWeather(dir);
        events = loadEvents(dir);
        forecastDays = buildForecastDays();
        geojson = buildGeojson();

        int stops = Arrays.stream(routes).mapToInt(r -> r.stopIds().length).sum();
        log.info("Артефакты загружены из {} за {} мс: маршрутов {}, остановок {}, история {}..{}, прогноз {}..{}, "
                        + "сегодня {}", dir.toAbsolutePath(), (System.nanoTime() - started) / 1_000_000, routes.length,
                stops, history.from(), history.to(), forecast.from(), forecast.to(), this.today);
    }

    public LocalDate today() {
        return today;
    }

    public Route[] routes() {
        return routes;
    }

    /** Индекс маршрута в массивах или -1, если такого маршрута нет. */
    public int routeIdx(int route) {
        return route >= 0 && route < routeIndex.length ? routeIndex[route] : -1;
    }

    public Grid forecast() {
        return forecast;
    }

    public Grid history() {
        return history;
    }

    public JsonNode routesJson() {
        return routesJson;
    }

    public JsonNode factorsJson() {
        return factorsJson;
    }

    public JsonNode metricsJson() {
        return metricsJson;
    }

    public JsonNode geojson() {
        return geojson;
    }

    public Factors factors() {
        return factors;
    }

    public List<CalendarDay> calendar() {
        return calendar;
    }

    public List<WeatherDay> weather() {
        return weather;
    }

    public List<Event> events() {
        return events;
    }

    /** Погода и тип каждого дня прогноза, индекс как у дней в forecast(). */
    public DayBase[] forecastDays() {
        return forecastDays;
    }

    private Route[] loadRoutes(JsonNode doc) {
        JsonNode arr = doc.path("routes");
        if (!arr.isArray() || arr.size() == 0) {
            throw fail("routes.json", "нет непустого массива routes");
        }
        List<Route> list = new ArrayList<>();
        Set<Integer> seen = new HashSet<>();
        for (JsonNode node : arr) {
            int number = node.path("route").asInt(-1);
            if (number < 1 || number > 9999 || !seen.add(number)) {
                throw fail("routes.json", "некорректный или повторный номер маршрута: " + node.path("route"));
            }
            String where = "маршрут " + number;
            for (String key : List.of("geometry", "stops")) {
                JsonNode v = node.get(key);
                if (v != null && !v.isNull() && !v.isArray()) {
                    throw fail("routes.json", where + ": " + key + " должно быть массивом");
                }
            }
            JsonNode stops = node.path("stops").isArray() ? node.path("stops") : json.createArrayNode();
            String[] ids = new String[stops.size()];
            Map<String, Integer> index = new HashMap<>();
            for (int i = 0; i < ids.length; i++) {
                JsonNode stop = stops.get(i);
                ids[i] = text(stop, "stop_id");
                if (ids[i] == null || ids[i].isEmpty() || index.put(ids[i], i) != null) {
                    throw fail("routes.json", where + ": пустой или повторный stop_id " + stop.path("stop_id"));
                }
                if (!stop.path("lat").isNumber() || !stop.path("lon").isNumber()) {
                    throw fail("routes.json", where + ", остановка " + ids[i] + ": lat и lon должны быть числами");
                }
            }
            float[] shares = new float[ids.length * HOURS];
            Arrays.fill(shares, -1f);
            list.add(new Route(number, text(node, "name"), text(node, "color"), ids, index, shares, node));
        }
        list.sort(Comparator.comparingInt(Route::route));
        return list.toArray(Route[]::new);
    }

    private Grid loadGrid(Path dir, String file, String... valueCols) {
        Csv.Table t = readCsv(dir, file);
        int cRoute = t.col("route");
        int cDate = t.col("date");
        int cHour = t.col("hour");
        int[] cVal = Arrays.stream(valueCols).mapToInt(t::col).toArray();
        int n = t.rows().size();
        if (n == 0) {
            throw fail(file, "нет строк с данными");
        }
        int[] rIdx = new int[n];
        long[] day = new long[n];
        int[] hour = new int[n];
        float[][] vals = new float[cVal.length][n];
        long min = Long.MAX_VALUE;
        long max = Long.MIN_VALUE;
        Map<String, Long> dates = new HashMap<>();
        for (int i = 0; i < n; i++) {
            String[] row = t.rows().get(i);
            String where = file + ", строка " + t.lines()[i];
            rIdx[i] = routeIdx(parseInt(where, "route", row[cRoute]));
            if (rIdx[i] < 0) {
                throw fail(where, "маршрута " + row[cRoute] + " нет в routes.json");
            }
            day[i] = dates.computeIfAbsent(row[cDate], s -> parseDate(where, "date", s).toEpochDay());
            hour[i] = parseInt(where, "hour", row[cHour]);
            if (hour[i] < 0 || hour[i] >= HOURS) {
                throw fail(where, "час должен быть от 0 до 23");
            }
            for (int c = 0; c < cVal.length; c++) {
                float v = parseFloat(where, valueCols[c], row[cVal[c]]);
                if (!(v >= 0) || Float.isInfinite(v)) {
                    throw fail(where, valueCols[c] + " должно быть неотрицательным числом");
                }
                // колонки квантилей идут по возрастанию: p10 <= p50 <= p90
                if (c > 0 && vals[c - 1][i] > v) {
                    throw fail(where, "нарушен порядок " + valueCols[c - 1] + " <= " + valueCols[c]);
                }
                vals[c][i] = v;
            }
            min = Math.min(min, day[i]);
            max = Math.max(max, day[i]);
        }
        int days = (int) (max - min + 1);
        long expected = (long) routes.length * days * HOURS;
        if (n != expected) {
            throw fail(file, "ожидается полная сетка " + routes.length + " маршрутов x " + days
                    + " дней x 24 часа = " + expected + " строк, найдено " + n);
        }
        float[][] cols = new float[cVal.length][n];
        BitSet seen = new BitSet(n);
        for (int i = 0; i < n; i++) {
            int idx = (rIdx[i] * days + (int) (day[i] - min)) * HOURS + hour[i];
            if (seen.get(idx)) {
                throw fail(file, "повтор строки: маршрут " + routes[rIdx[i]].route() + ", "
                        + LocalDate.ofEpochDay(day[i]) + ", час " + hour[i]);
            }
            seen.set(idx);
            for (int c = 0; c < cols.length; c++) {
                cols[c][idx] = vals[c][i];
            }
        }
        return new Grid(LocalDate.ofEpochDay(min), days, cols);
    }

    /**
     * Доли остановок. Файл собирается отдельно от routes.json, поэтому расхождение по остановкам
     * не валит запуск: лишние строки пропускаем, а доли каждого часа приводим к сумме 1.
     * Итоги по маршрутам от долей не зависят, страдает только разбивка по остановкам.
     */
    private void loadShares(Path dir) {
        String file = "stop_shares.csv";
        Csv.Table t = readCsv(dir, file);
        int cRoute = t.col("route");
        int cStop = t.col("stop_id");
        int cHour = t.col("hour");
        int cShare = t.col("share");
        Map<Integer, Integer> skipped = new LinkedHashMap<>();
        for (int i = 0; i < t.rows().size(); i++) {
            String[] row = t.rows().get(i);
            String where = file + ", строка " + t.lines()[i];
            int number = parseInt(where, "route", row[cRoute]);
            int hour = parseInt(where, "hour", row[cHour]);
            float share = parseFloat(where, "share", row[cShare]);
            if (hour < 0 || hour >= HOURS || !(share >= 0 && share <= 1)) {
                throw fail(where, "час должен быть от 0 до 23, доля от 0 до 1");
            }
            int r = routeIdx(number);
            Integer stop = r < 0 ? null : routes[r].stopIndex().get(row[cStop]);
            if (stop == null) {
                skipped.merge(number, 1, Integer::sum);
                continue;
            }
            float[] shares = routes[r].shares();
            if (shares[stop * HOURS + hour] >= 0) {
                throw fail(where, "повтор доли для остановки " + row[cStop] + ", час " + hour);
            }
            shares[stop * HOURS + hour] = share;
        }
        skipped.forEach((route, rows) ->
                log.warn("{}: маршрут {} - пропущено строк: {}, таких остановок нет в routes.json", file, route, rows));
        for (Route route : routes) {
            int n = route.stopIds().length;
            float[] shares = route.shares();
            int fixed = 0;
            for (int h = 0; h < HOURS && n > 0; h++) {
                double sum = 0;
                for (int s = 0; s < n; s++) {
                    sum += Math.max(shares[s * HOURS + h], 0);
                }
                if (Math.abs(sum - 1) > SHARE_TOLERANCE) {
                    fixed++;
                }
                for (int s = 0; s < n; s++) {
                    float v = Math.max(shares[s * HOURS + h], 0);
                    // нет долей на этот час - делим поровну, чтобы карта и фильтр по остановке работали
                    shares[s * HOURS + h] = sum > 0 ? (float) (v / sum) : 1f / n;
                }
            }
            if (fixed > 0) {
                log.warn("{}: у маршрута {} доли остановок в {} ч. из 24 не давали в сумме 1 - нормированы",
                        file, route.route(), fixed);
            }
        }
    }

    private Factors loadFactors(JsonNode doc) {
        String file = "factors.json";
        JsonNode w = doc.path("weather");
        String[] keys = {"/coef/rain_warm", "/coef/rain_we", "/coef/snow", "/coef/heat", "/coef/cold",
                "/rain_warm_min_t", "/heat_above_t", "/cold_below_t"};
        double[] v = new double[keys.length];
        for (int i = 0; i < keys.length; i++) {
            JsonNode node = w.at(keys[i]);
            if (!node.isNumber()) {
                throw fail(file, "weather" + keys[i].replace('/', '.') + " должно быть числом");
            }
            v[i] = node.asDouble();
        }
        Map<String, double[]> limits = new LinkedHashMap<>();
        for (String key : LIMIT_KEYS) {
            JsonNode a = doc.path("limits").path(key);
            if (!a.isArray() || a.size() != 2 || !a.get(0).isNumber() || !a.get(1).isNumber()
                    || a.get(0).asDouble() > a.get(1).asDouble()) {
                throw fail(file, "limits." + key + " должно быть парой [min, max]");
            }
            limits.put(key, new double[] {a.get(0).asDouble(), a.get(1).asDouble()});
        }
        if (!doc.path("presets").isArray()) {
            throw fail(file, "presets должно быть массивом");
        }
        return new Factors(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], limits);
    }

    private List<CalendarDay> loadCalendar(Path dir) {
        String file = "calendar.csv";
        Csv.Table t = readCsv(dir, file);
        int cDate = t.col("date");
        int cType = t.col("day_type");
        int cHol = t.col("is_holiday");
        int cPre = t.col("is_preholiday");
        int cSchool = t.col("school_break");
        int cNote = t.col("note");
        List<CalendarDay> out = new ArrayList<>();
        Set<LocalDate> dates = new HashSet<>();
        for (int i = 0; i < t.rows().size(); i++) {
            String[] row = t.rows().get(i);
            String where = file + ", строка " + t.lines()[i];
            LocalDate date = parseDate(where, "date", row[cDate]);
            if (!DAY_TYPES.contains(row[cType])) {
                throw fail(where, "day_type должен быть одним из " + DAY_TYPES);
            }
            dates.add(date);
            out.add(new CalendarDay(date.toString(), row[cType], flag(where, "is_holiday", row[cHol]),
                    flag(where, "is_preholiday", row[cPre]), flag(where, "school_break", row[cSchool]), row[cNote]));
        }
        for (LocalDate d = forecast.from(); !d.isAfter(forecast.to()); d = d.plusDays(1)) {
            if (!dates.contains(d)) {
                throw fail(file, "нет даты " + d + " из периода прогноза");
            }
        }
        out.sort(Comparator.comparing(CalendarDay::date));
        return List.copyOf(out);
    }

    private List<WeatherDay> loadWeather(Path dir) {
        String file = "weather_daily.csv";
        Csv.Table t = readCsv(dir, file);
        int cDate = t.col("date");
        int cTemp = t.col("t_mean");
        int cPrecip = t.col("precip_mm");
        int cSnow = t.col("snow_cm");
        int cRainDay = t.col("rain_day_mm");
        int cSnowDay = t.col("snow_day_cm");
        int cSource = t.col("source");
        List<WeatherDay> out = new ArrayList<>();
        for (int i = 0; i < t.rows().size(); i++) {
            String[] row = t.rows().get(i);
            String where = file + ", строка " + t.lines()[i];
            if (!WEATHER_SOURCES.contains(row[cSource])) {
                throw fail(where, "source должен быть одним из " + WEATHER_SOURCES);
            }
            out.add(new WeatherDay(parseDate(where, "date", row[cDate]).toString(), optDouble(where, "t_mean", row[cTemp]),
                    optDouble(where, "precip_mm", row[cPrecip]), optDouble(where, "snow_cm", row[cSnow]),
                    optDouble(where, "rain_day_mm", row[cRainDay]), optDouble(where, "snow_day_cm", row[cSnowDay]),
                    row[cSource]));
        }
        out.sort(Comparator.comparing(WeatherDay::date));
        return List.copyOf(out);
    }

    private List<Event> loadEvents(Path dir) {
        String file = "events.csv";
        Csv.Table t = readCsv(dir, file);
        int cRoute = t.col("route");
        int cFrom = t.col("date_from");
        int cTo = t.col("date_to");
        int cDays = t.col("days");
        int cFactor = t.col("factor");
        int cTitle = t.col("title");
        int cUrl = t.col("source_url");
        List<Event> out = new ArrayList<>();
        for (int i = 0; i < t.rows().size(); i++) {
            String[] row = t.rows().get(i);
            String where = file + ", строка " + t.lines()[i];
            int route = parseInt(where, "route", row[cRoute]);
            if (routeIdx(route) < 0) {
                throw fail(where, "маршрута " + route + " нет в routes.json");
            }
            LocalDate from = parseDate(where, "date_from", row[cFrom]);
            LocalDate to = parseDate(where, "date_to", row[cTo]);
            double factor = parseDouble(where, "factor", row[cFactor]);
            if (to.isBefore(from) || !EVENT_DAYS.contains(row[cDays]) || !(factor >= 0)) {
                throw fail(where, "нужны date_from <= date_to, days из " + EVENT_DAYS + " и factor >= 0");
            }
            out.add(new Event(route, from.toString(), to.toString(), row[cDays], factor, row[cTitle], row[cUrl]));
        }
        return List.copyOf(out);
    }

    /** Сценарии пересчитывают погоду каждого дня прогноза, поэтому без нее или без типа дня запуск не имеет смысла. */
    private DayBase[] buildForecastDays() {
        Map<String, WeatherDay> byDate = new HashMap<>();
        weather.forEach(w -> byDate.put(w.date(), w));
        Map<String, String> dayType = new HashMap<>();
        calendar.forEach(c -> dayType.put(c.date(), c.dayType()));
        DayBase[] out = new DayBase[forecast.days()];
        for (int d = 0; d < out.length; d++) {
            String date = forecast.from().plusDays(d).toString();
            WeatherDay w = byDate.get(date);
            if (w == null || w.tMean() == null || w.rainDayMm() == null || w.snowDayCm() == null
                    || w.rainDayMm() < 0 || w.snowDayCm() < 0) {
                throw fail("weather_daily.csv", "для даты прогноза " + date
                        + " нужны t_mean и неотрицательные rain_day_mm и snow_day_cm");
            }
            out[d] = new DayBase(w.tMean(), w.rainDayMm(), w.snowDayCm(), !dayType.get(date).equals("workday"));
        }
        return out;
    }

    private JsonNode buildGeojson() {
        ObjectNode fc = json.createObjectNode();
        fc.put("type", "FeatureCollection");
        ArrayNode features = fc.putArray("features");
        for (Route r : routes) {
            JsonNode geometry = r.json().path("geometry");
            if (geometry.size() > 0) {
                ObjectNode f = features.addObject();
                f.put("type", "Feature");
                ObjectNode g = f.putObject("geometry");
                g.put("type", "MultiLineString");
                g.set("coordinates", geometry);
                ObjectNode p = f.putObject("properties");
                p.put("route", r.route());
                p.put("name", r.name());
                p.put("color", r.color());
            }
            for (JsonNode stop : r.json().path("stops")) {
                ObjectNode f = features.addObject();
                f.put("type", "Feature");
                ObjectNode g = f.putObject("geometry");
                g.put("type", "Point");
                g.putArray("coordinates").add(stop.path("lon").asDouble()).add(stop.path("lat").asDouble());
                ObjectNode p = f.putObject("properties");
                p.put("route", r.route());
                p.put("stop_id", text(stop, "stop_id"));
                p.put("name", text(stop, "name"));
                p.put("seq", stop.path("seq").asInt());
                p.put("terminal", stop.path("terminal").asBoolean());
                p.put("near_rail", stop.path("near_rail").asBoolean());
            }
        }
        return fc;
    }

    private JsonNode readJson(Path dir, String file) {
        try {
            return json.readTree(dir.resolve(file));
        } catch (RuntimeException e) {
            throw fail(file, "не удалось прочитать JSON: " + e.getMessage());
        }
    }

    private static Csv.Table readCsv(Path dir, String file) {
        try {
            return Csv.read(dir.resolve(file), ',');
        } catch (IOException e) {
            throw fail(file, "не удалось прочитать файл: " + e);
        }
    }

    private static String text(JsonNode node, String field) {
        JsonNode v = node.get(field);
        return v == null || v.isNull() || !v.isValueNode() ? null : v.asString();
    }

    private static LocalDate configDate(String name, String value) {
        try {
            return LocalDate.parse(value.trim());
        } catch (DateTimeParseException e) {
            throw new IllegalStateException(name + " должен быть датой ГГГГ-ММ-ДД, указано '" + value + "'");
        }
    }

    private static LocalDate parseDate(String where, String col, String s) {
        // pandas иногда пишет дату как "2025-01-01 00:00:00" - полночь принимаем
        if (s.length() > 10 && s.substring(10).matches("[ T]00:00(:00)?")) {
            s = s.substring(0, 10);
        }
        try {
            return LocalDate.parse(s);
        } catch (DateTimeParseException e) {
            throw fail(where, col + " = '" + s + "' не является датой ГГГГ-ММ-ДД");
        }
    }

    private static int parseInt(String where, String col, String s) {
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            throw fail(where, col + " = '" + s + "' не является целым числом");
        }
    }

    private static float parseFloat(String where, String col, String s) {
        try {
            return Float.parseFloat(s.trim());
        } catch (NumberFormatException e) {
            throw fail(where, col + " = '" + s + "' не является числом");
        }
    }

    private static double parseDouble(String where, String col, String s) {
        try {
            return Double.parseDouble(s.trim());
        } catch (NumberFormatException e) {
            throw fail(where, col + " = '" + s + "' не является числом");
        }
    }

    private static Double optDouble(String where, String col, String s) {
        return s.isBlank() ? null : parseDouble(where, col, s);
    }

    private static int flag(String where, String col, String s) {
        return switch (s.trim()) {
            case "0" -> 0;
            case "1" -> 1;
            default -> throw fail(where, col + " должен быть 0 или 1");
        };
    }

    private static IllegalStateException fail(String where, String message) {
        return new IllegalStateException("Артефакт " + where + ": " + message);
    }
}
