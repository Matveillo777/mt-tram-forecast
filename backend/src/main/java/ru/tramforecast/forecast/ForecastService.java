package ru.tramforecast.forecast;

import java.time.LocalDate;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.stereotype.Service;

import ru.tramforecast.ApiException;
import ru.tramforecast.data.DataStore;
import ru.tramforecast.data.DataStore.DayBase;
import ru.tramforecast.data.DataStore.Grid;
import ru.tramforecast.data.DataStore.Route;

import static ru.tramforecast.data.DataStore.HOURS;

/** Выборка и агрегация прогноза и истории по маршрутам, остановкам, часам и периодам. */
@Service
public class ForecastService {

    public static final List<String> HORIZONS = List.of("day", "month", "year");
    public static final List<String> GRANULARITIES = List.of("hour", "day", "month");
    private static final Map<String, Integer> HORIZON_DAYS = Map.of("day", 1, "month", 30, "year", 365);
    private static final Map<String, String> DEFAULT_GRANULARITY = Map.of("day", "hour", "month", "day", "year", "month");

    public record Point(String t, double p10, double p50, double p90, double value) {
    }

    public record Total(double p10, double p50, double p90, double value) {
    }

    /** Итоговый множитель за выборку, если применить только один фактор сценария. */
    public record FactorEffects(double temp, double precip, double snow, double event, double season) {
    }

    /** multiplier - итоговый множитель за выборку: сумма p50 с поправками к сумме базового p50. */
    public record Forecast(String horizon, String from, String to, String granularity, int[] routes, String stop,
                           double multiplier, FactorEffects factorEffects, List<Point> series, Total total) {
    }

    public record HistoryPoint(String t, double actual) {
    }

    public record HistoryTotal(double actual) {
    }

    public record History(String from, String to, String granularity, int[] routes, String stop,
                          List<HistoryPoint> series, HistoryTotal total) {
    }

    public record StopValue(String stopId, double value) {
    }

    public record RouteValue(int route, double value, List<StopValue> stops) {
    }

    public record MapView(String date, Integer hour, String kind, double multiplier, List<RouteValue> routes) {
    }

    public record DispatchHour(int hour, double p50, double p90, double peakLoad, int tripsNeeded, double intervalMin,
                               int planned, String risk) {
    }

    public record Dispatch(int route, String date, int capacity, double peakShare, int plannedPerHour,
                           double multiplier, List<DispatchHour> hours) {
    }

    /** Строка выгрузки: один маршрут, один период. */
    public record ExportRow(String period, int route, String stop, double p10, double p50, double p90, double value) {
    }

    public record ExportData(String from, String to, List<ExportRow> rows) {
    }

    /** Поправки сценария из запроса, уже проверенные по границам factors.json. */
    record Scenario(double tempDelta, double precipMm, double snowCm, double eventPct, double seasonPct) {
        boolean neutral() {
            return tempDelta == 0 && precipMm == 0 && snowCm == 0 && eventPct == 0 && seasonPct == 0;
        }
    }

    private static final FactorEffects NO_EFFECTS = new FactorEffects(1, 1, 1, 1, 1);

    /** Разобранный и проверенный запрос. routes - индексы в массивах DataStore. */
    record Query(String horizon, LocalDate from, LocalDate to, int hourFrom, int hourTo, int[] routes, int stop,
                 String stopId, String granularity, Scenario scenario) {
    }

    private record Buckets(int[] ofDay, List<String> labels, boolean hourly) {
    }

    private final DataStore store;

    public ForecastService(DataStore store) {
        this.store = store;
    }

    public Forecast forecast(ForecastParams p, CorrectionParams c) {
        Query q = forecastQuery(p, c);
        Buckets b = buckets(q.from(), q.to(), q.hourFrom(), q.hourTo(), q.granularity());
        Scenario s = q.scenario();
        // без поправок множители не нужны: это большинство запросов, им не нужен второй проход по данным
        double[] m = s.neutral() ? null : dayMultipliers(s, q.from(), b.ofDay().length);
        double[][] sums = sum(store.forecast(), q, q.routes(), b, m);
        List<Point> series = new ArrayList<>(b.labels().size());
        double[] tot = new double[3];
        for (int i = 0; i < b.labels().size(); i++) {
            series.add(new Point(b.labels().get(i), round1(sums[0][i]), round1(sums[1][i]), round1(sums[2][i]),
                    round1(sums[1][i])));
            for (int k = 0; k < 3; k++) {
                tot[k] += sums[k][i];
            }
        }
        Total total = new Total(round1(tot[0]), round1(tot[1]), round1(tot[2]), round1(tot[1]));
        if (m == null) {
            return new Forecast(q.horizon(), q.from().toString(), q.to().toString(), q.granularity(), numbers(q.routes()),
                    q.stopId(), 1.0, NO_EFFECTS, series, total);
        }
        // вес дня - базовый p50 выборки за этот день, по нему поправки дней сводятся в один множитель
        double[] w = sum(store.forecast(), q, q.routes(),
                buckets(q.from(), q.to(), q.hourFrom(), q.hourTo(), "day"), null)[1];
        FactorEffects effects = new FactorEffects(
                effective(dayMultipliers(new Scenario(s.tempDelta(), 0, 0, 0, 0), q.from(), w.length), w),
                effective(dayMultipliers(new Scenario(0, s.precipMm(), 0, 0, 0), q.from(), w.length), w),
                effective(dayMultipliers(new Scenario(0, 0, s.snowCm(), 0, 0), q.from(), w.length), w),
                effective(dayMultipliers(new Scenario(0, 0, 0, s.eventPct(), 0), q.from(), w.length), w),
                effective(dayMultipliers(new Scenario(0, 0, 0, 0, s.seasonPct()), q.from(), w.length), w));
        return new Forecast(q.horizon(), q.from().toString(), q.to().toString(), q.granularity(), numbers(q.routes()),
                q.stopId(), effective(m, w), effects, series, total);
    }

    /** Те же параметры, что у /forecast, но с разбивкой по маршрутам. */
    public ExportData exportRows(ForecastParams p, CorrectionParams c) {
        Query q = forecastQuery(p, c);
        Buckets b = buckets(q.from(), q.to(), q.hourFrom(), q.hourTo(), q.granularity());
        double[] m = q.scenario().neutral() ? null : dayMultipliers(q.scenario(), q.from(), b.ofDay().length);
        List<ExportRow> rows = new ArrayList<>(b.labels().size() * q.routes().length);
        for (int r : q.routes()) {
            double[][] sums = sum(store.forecast(), q, new int[] {r}, b, m);
            int route = store.routes()[r].route();
            for (int i = 0; i < b.labels().size(); i++) {
                rows.add(new ExportRow(b.labels().get(i), route, q.stopId(), round1(sums[0][i]), round1(sums[1][i]),
                        round1(sums[2][i]), round1(sums[1][i])));
            }
        }
        return new ExportData(q.from().toString(), q.to().toString(), rows);
    }

    private Query forecastQuery(ForecastParams p, CorrectionParams c) {
        Grid g = store.forecast();
        String horizon = Params.oneOf("horizon", p.horizon(), "day", HORIZONS);
        LocalDate from = Params.date("from", p.from(), store.today());
        LocalDate to = Params.date("to", p.to(), min(from.plusDays(HORIZON_DAYS.get(horizon) - 1L), g.to()));
        checkRange("прогноза", g, from, to);
        int[] hours = hourWindow(p.hourFrom(), p.hourTo());
        int[] routes = routes(p.route());
        int stop = stop(routes, p.stop());
        String gran = Params.oneOf("granularity", p.granularity(), DEFAULT_GRANULARITY.get(horizon), GRANULARITIES);
        return new Query(horizon, from, to, hours[0], hours[1], routes, stop, stop < 0 ? null : p.stop().trim(), gran,
                scenario(c));
    }

    public History history(HistoryParams p) {
        Grid g = store.history();
        LocalDate to = Params.date("to", p.to(), g.to());
        LocalDate from = Params.date("from", p.from(), max(to.minusDays(29), g.from()));
        checkRange("истории", g, from, to);
        int[] hours = hourWindow(p.hourFrom(), p.hourTo());
        int[] routes = routes(p.route());
        int stop = stop(routes, p.stop());
        long days = to.toEpochDay() - from.toEpochDay() + 1;
        String gran = Params.oneOf("granularity", p.granularity(), days == 1 ? "hour" : days <= 92 ? "day" : "month",
                GRANULARITIES);
        Query q = new Query(null, from, to, hours[0], hours[1], routes, stop, stop < 0 ? null : p.stop().trim(), gran,
                null);
        Buckets b = buckets(from, to, hours[0], hours[1], gran);
        double[] sums = sum(g, q, routes, b, null)[0];
        List<HistoryPoint> series = new ArrayList<>(sums.length);
        double total = 0;
        for (int i = 0; i < sums.length; i++) {
            series.add(new HistoryPoint(b.labels().get(i), round1(sums[i])));
            total += sums[i];
        }
        return new History(from.toString(), to.toString(), gran, numbers(routes), q.stopId(), series,
                new HistoryTotal(round1(total)));
    }

    /** Нагрузка по маршрутам и остановкам на дату: прогноз для будущих дат, факт для прошедших. */
    public MapView map(String dateParam, String hourParam, CorrectionParams c) {
        LocalDate date = Params.date("date", dateParam, store.today());
        Integer hour = Params.blank(hourParam) ? null : Params.integer("hour", hourParam, 0, 0, HOURS - 1);
        Scenario scenario = scenario(c);
        double m = 1;
        Grid g;
        int col;
        String kind;
        if (store.forecast().contains(date)) {
            g = store.forecast();
            col = 1;
            kind = "forecast";
            m = dayMultipliers(scenario, date, 1)[0];
        } else if (store.history().contains(date)) {
            // факт сценарием не правим
            g = store.history();
            col = 0;
            kind = "history";
        } else {
            throw ApiException.badRequest("Дата " + date + " вне истории (" + store.history().from() + " - "
                    + store.history().to() + ") и прогноза (" + store.forecast().from() + " - "
                    + store.forecast().to() + ")");
        }
        int h0 = hour == null ? 0 : hour;
        int h1 = hour == null ? HOURS - 1 : hour;
        int day = g.day(date);
        List<RouteValue> out = new ArrayList<>();
        Route[] all = store.routes();
        for (int r = 0; r < all.length; r++) {
            Route route = all[r];
            double[] perHour = new double[HOURS];
            double total = 0;
            for (int h = h0; h <= h1; h++) {
                perHour[h] = g.cols()[col][g.index(r, day, h)] * m;
                total += perHour[h];
            }
            List<StopValue> stops = new ArrayList<>(route.stopIds().length);
            for (int s = 0; s < route.stopIds().length; s++) {
                double v = 0;
                for (int h = h0; h <= h1; h++) {
                    v += perHour[h] * route.shares()[s * HOURS + h];
                }
                stops.add(new StopValue(route.stopIds()[s], round1(v)));
            }
            out.add(new RouteValue(route.route(), round1(total), stops));
        }
        return new MapView(date.toString(), hour, kind, round4(m), out);
    }

    public Dispatch dispatch(String routeParam, String dateParam, String capacityParam, String peakShareParam,
                             String plannedParam, CorrectionParams c) {
        String routeText = Params.blank(routeParam) ? "17" : routeParam.trim();
        int[] routes = routes(routeText);
        if (routes.length != 1) {
            throw ApiException.badRequest("Параметр route: для расчета выпуска нужен ровно один маршрут");
        }
        Grid g = store.forecast();
        LocalDate date = Params.date("date", dateParam, store.today());
        checkRange("прогноза", g, date, date);
        int capacity = Params.integer("capacity", capacityParam, 190, 1, 1000);
        double peakShare = Params.number("peakShare", peakShareParam, 0.35, 0.01, 1);
        int planned = Params.integer("plannedPerHour", plannedParam, 8, 0, 60);
        double m = dayMultipliers(scenario(c), date, 1)[0];
        int r = routes[0];
        int day = g.day(date);
        List<DispatchHour> hours = new ArrayList<>(HOURS);
        for (int h = 0; h < HOURS; h++) {
            int idx = g.index(r, day, h);
            double p50 = g.cols()[1][idx] * m;
            double p90 = g.cols()[2][idx] * m;
            double peak = p90 * peakShare;
            int trips = (int) Math.ceil(peak / capacity - 1e-9);
            String risk = trips > planned ? "overload" : trips > 0.85 * planned ? "tight" : "ok";
            hours.add(new DispatchHour(h, round1(p50), round1(p90), round1(peak), trips,
                    round1(60.0 / Math.max(trips, 1)), planned, risk));
        }
        return new Dispatch(store.routes()[r].route(), date.toString(), capacity, peakShare, planned, round4(m), hours);
    }

    private Scenario scenario(CorrectionParams c) {
        return new Scenario(correction("tempDelta", "temp_delta", c.tempDelta()),
                correction("precipMm", "precip_mm", c.precipMm()),
                correction("snowCm", "snow_cm", c.snowCm()),
                correction("eventPct", "event_pct", c.eventPct()),
                correction("seasonPct", "season_pct", c.seasonPct()));
    }

    /**
     * Множитель сценария для каждого дня начиная с from, по тем же правилам, что в модели уровня дня:
     * погода дня сдвигается на tempDelta, дневные осадки и снег заменяются заданными в сценарии,
     * и результат сравнивается с погодой, на которой построен прогноз. Событие и сезон общие для всех дней.
     */
    private double[] dayMultipliers(Scenario s, LocalDate from, int days) {
        DataStore.Factors f = store.factors();
        DayBase[] base = store.forecastDays();
        int day0 = store.forecast().day(from);
        double common = (1 + s.eventPct() / 100) * (1 + s.seasonPct() / 100);
        double[] out = new double[days];
        for (int d = 0; d < days; d++) {
            DayBase b = base[day0 + d];
            double rain = s.precipMm() > 0 ? s.precipMm() : b.rainMm();
            double snow = s.snowCm() > 0 ? s.snowCm() : b.snowCm();
            double weather = Math.exp(f.weatherLog(b.t() + s.tempDelta(), rain, snow, b.nonWorking())
                    - f.weatherLog(b.t(), b.rainMm(), b.snowCm(), b.nonWorking()));
            out[d] = Math.max(0, weather * common);
        }
        return out;
    }

    /** Множители дней, сведенные в один с весами дней; если в выборке нет посадок - просто среднее. */
    private static double effective(double[] m, double[] w) {
        double num = 0;
        double den = 0;
        double mean = 0;
        for (int d = 0; d < m.length; d++) {
            num += m[d] * w[d];
            den += w[d];
            mean += m[d] / m.length;
        }
        return round4(den > 0 ? num / den : mean);
    }

    private double correction(String name, String key, String value) {
        double[] limit = store.factors().limits().get(key);
        return Params.number(name, value, 0, limit[0], limit[1]);
    }

    private int[] routes(String param) {
        if (Params.blank(param)) {
            int[] all = new int[store.routes().length];
            Arrays.setAll(all, i -> i);
            return all;
        }
        Set<Integer> out = new LinkedHashSet<>();
        for (String part : param.split(",")) {
            String s = part.trim();
            if (s.isEmpty()) {
                continue;
            }
            int number;
            try {
                number = Integer.parseInt(s);
            } catch (NumberFormatException e) {
                throw ApiException.badRequest("Параметр route: номер маршрута должен быть целым числом, получено '"
                        + s + "'");
            }
            out.add(routeIndex(number));
        }
        if (out.isEmpty()) {
            return routes(null);
        }
        return out.stream().mapToInt(Integer::intValue).toArray();
    }

    public int routeIndex(int number) {
        int idx = store.routeIdx(number);
        if (idx < 0) {
            throw ApiException.notFound("Маршрут " + number + " не найден. Доступные маршруты: "
                    + Arrays.toString(numbers(null)).replaceAll("[\\[\\]]", ""));
        }
        return idx;
    }

    private int stop(int[] routes, String stopParam) {
        if (Params.blank(stopParam)) {
            return -1;
        }
        if (routes.length != 1) {
            throw ApiException.badRequest("Параметр stop работает только с одним маршрутом: укажите его в route");
        }
        Route route = store.routes()[routes[0]];
        Integer idx = route.stopIndex().get(stopParam.trim());
        if (idx == null) {
            throw ApiException.notFound(route.stopIds().length == 0
                    ? "Для маршрута " + route.route() + " нет данных об остановках"
                    : "Остановка " + stopParam.trim() + " не найдена на маршруте " + route.route());
        }
        return idx;
    }

    private static int[] hourWindow(String fromParam, String toParam) {
        int from = Params.integer("hourFrom", fromParam, 0, 0, HOURS - 1);
        int to = Params.integer("hourTo", toParam, HOURS - 1, 0, HOURS - 1);
        if (from > to) {
            throw ApiException.badRequest("hourFrom (" + from + ") не может быть больше hourTo (" + to + ")");
        }
        return new int[] {from, to};
    }

    private static void checkRange(String what, Grid g, LocalDate from, LocalDate to) {
        if (!g.contains(from) || !g.contains(to)) {
            throw ApiException.badRequest("Период " + from + " - " + to + " выходит за границы " + what + ": "
                    + g.from() + " - " + g.to());
        }
        if (from.isAfter(to)) {
            throw ApiException.badRequest("Дата from (" + from + ") позже даты to (" + to + ")");
        }
    }

    private static Buckets buckets(LocalDate from, LocalDate to, int hourFrom, int hourTo, String gran) {
        int days = (int) (to.toEpochDay() - from.toEpochDay() + 1);
        int[] ofDay = new int[days];
        List<String> labels = new ArrayList<>();
        YearMonth month = null;
        for (int d = 0; d < days; d++) {
            LocalDate date = from.plusDays(d);
            switch (gran) {
                case "hour" -> {
                    ofDay[d] = labels.size();
                    for (int h = hourFrom; h <= hourTo; h++) {
                        labels.add(date + "T" + (h < 10 ? "0" : "") + h + ":00");
                    }
                }
                case "day" -> {
                    ofDay[d] = labels.size();
                    labels.add(date.toString());
                }
                default -> {
                    YearMonth ym = YearMonth.from(date);
                    if (!ym.equals(month)) {
                        month = ym;
                        labels.add(ym.toString());
                    }
                    ofDay[d] = labels.size() - 1;
                }
            }
        }
        return new Buckets(ofDay, labels, gran.equals("hour"));
    }

    /** Один проход по почасовой сетке: суммы по всем колонкам для каждого бакета. dayMult - множитель дня или null. */
    private double[][] sum(Grid g, Query q, int[] routes, Buckets b, double[] dayMult) {
        float[][] cols = g.cols();
        double[][] out = new double[cols.length][b.labels().size()];
        float[] shares = q.stop() < 0 ? null : store.routes()[routes[0]].shares();
        int day0 = g.day(q.from());
        int days = b.ofDay().length;
        for (int r : routes) {
            for (int d = 0; d < days; d++) {
                int base = g.index(r, day0 + d, 0);
                int bucket = b.ofDay()[d];
                double k = dayMult == null ? 1 : dayMult[d];
                for (int h = q.hourFrom(); h <= q.hourTo(); h++) {
                    double w = (shares == null ? 1 : shares[q.stop() * HOURS + h]) * k;
                    int o = b.hourly() ? bucket + h - q.hourFrom() : bucket;
                    for (int c = 0; c < cols.length; c++) {
                        out[c][o] += cols[c][base + h] * w;
                    }
                }
            }
        }
        return out;
    }

    private int[] numbers(int[] idx) {
        Route[] all = store.routes();
        if (idx == null) {
            return Arrays.stream(all).mapToInt(Route::route).toArray();
        }
        return Arrays.stream(idx).map(i -> all[i].route()).toArray();
    }

    private static LocalDate min(LocalDate a, LocalDate b) {
        return a.isBefore(b) ? a : b;
    }

    private static LocalDate max(LocalDate a, LocalDate b) {
        return a.isAfter(b) ? a : b;
    }

    public static double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }

    private static double round4(double v) {
        return Math.round(v * 10000) / 10000.0;
    }
}
