package ru.tramforecast;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;

/**
 * Маленький набор артефактов с простыми формулами, чтобы в тестах суммы считались в уме:
 * прогноз p50 = маршрут + час, p10 = p50 / 2, p90 = p50 * 2; история = маршрут * 10 + час.
 * Погода прогноза: 4 °C и 1 мм дневного дождя без снега каждый день (1 ноября - 2.1 °C).
 */
final class TestData {

    static final int[] ROUTES = {7, 17, 50};
    static final LocalDate FORECAST_FROM = LocalDate.of(2025, 11, 1);
    static final LocalDate FORECAST_TO = LocalDate.of(2026, 1, 31);
    static final LocalDate HISTORY_FROM = LocalDate.of(2025, 10, 1);
    static final LocalDate HISTORY_TO = LocalDate.of(2025, 10, 31);

    private TestData() {
    }

    static Path create() {
        try {
            Path dir = Files.createTempDirectory("tram-test-data");
            dir.toFile().deleteOnExit();
            write(dir, "routes.json", """
                    {"routes": [
                      {"route": 17, "name": "Семнадцатый", "color": "#111111",
                       "geometry": [[[37.60, 55.80], [37.61, 55.81]]],
                       "stops": [
                         {"stop_id": "s1", "name": "Первая", "lat": 55.80, "lon": 37.60, "seq": 1, "terminal": true, "near_rail": false},
                         {"stop_id": "s2", "name": "Вторая", "lat": 55.805, "lon": 37.605, "seq": 2, "terminal": false, "near_rail": true},
                         {"stop_id": "s3", "name": "Третья", "lat": 55.81, "lon": 37.61, "seq": 3, "terminal": true, "near_rail": false}],
                       "source": "test", "extra": {"any": 1}},
                      {"route": 7, "name": "Седьмой", "color": "#222222",
                       "geometry": [[[37.70, 55.70], [37.71, 55.71]]],
                       "stops": [
                         {"stop_id": "a1", "name": "А1", "lat": 55.70, "lon": 37.70, "seq": 1, "terminal": true, "near_rail": false},
                         {"stop_id": "a2", "name": "А2", "lat": 55.71, "lon": 37.71, "seq": 2, "terminal": true, "near_rail": false}]},
                      {"route": 50, "name": "Маршрут 50", "color": "#333333", "geometry": []}
                    ]}
                    """);
            StringBuilder f = new StringBuilder("route,date,hour,p10,p50,p90\n");
            StringBuilder h = new StringBuilder("route,date,hour,boardings\n");
            for (int r : ROUTES) {
                for (LocalDate d = FORECAST_FROM; !d.isAfter(FORECAST_TO); d = d.plusDays(1)) {
                    for (int hour = 0; hour < 24; hour++) {
                        double p50 = r + hour;
                        f.append(r).append(',').append(d).append(',').append(hour).append(',')
                                .append(p50 / 2).append(',').append(p50).append(',').append(p50 * 2).append('\n');
                    }
                }
                for (LocalDate d = HISTORY_FROM; !d.isAfter(HISTORY_TO); d = d.plusDays(1)) {
                    for (int hour = 0; hour < 24; hour++) {
                        h.append(r).append(',').append(d).append(',').append(hour).append(',')
                                .append(r * 10 + hour).append('\n');
                    }
                }
            }
            write(dir, "forecast_hourly.csv", f.toString());
            write(dir, "history_hourly.csv", h.toString());
            StringBuilder s = new StringBuilder("route,stop_id,hour,share\n");
            for (int hour = 0; hour < 24; hour++) {
                s.append("7,a1,").append(hour).append(",0.25\n").append("7,a2,").append(hour).append(",0.75\n");
                s.append("17,s1,").append(hour).append(",0.2\n").append("17,s2,").append(hour).append(",0.3\n")
                        .append("17,s3,").append(hour).append(",0.5\n");
            }
            // остановки и маршрута нет в routes.json - такие строки пропускаются, а не валят запуск
            s.append("17,zz,0,0.1\n").append("99,x,0,1\n");
            write(dir, "stop_shares.csv", s.toString());
            StringBuilder c = new StringBuilder("date,day_type,is_holiday,is_preholiday,school_break,note\n");
            for (LocalDate d = HISTORY_FROM; !d.isAfter(FORECAST_TO); d = d.plusDays(1)) {
                boolean holiday = d.equals(LocalDate.of(2025, 11, 4));
                String type = holiday ? "holiday" : switch (d.getDayOfWeek()) {
                    case SATURDAY -> "saturday";
                    case SUNDAY -> "sunday";
                    default -> "workday";
                };
                c.append(d).append(',').append(type).append(',').append(holiday ? 1 : 0)
                        .append(",0,0,").append(holiday ? "День народного единства" : "").append('\n');
            }
            write(dir, "calendar.csv", c.toString());
            StringBuilder w = new StringBuilder("""
                    date,t_mean,precip_mm,snow_cm,rain_day_mm,snow_day_cm,source,extra
                    2025-10-01,8.5,0.0,0.0,0.0,0.0,observed,
                    2025-11-01,2.1,1.5,,1.0,0.0,climate,x
                    """);
            for (LocalDate d = FORECAST_FROM.plusDays(1); !d.isAfter(FORECAST_TO); d = d.plusDays(1)) {
                w.append(d).append(",4.0,1.0,0.0,1.0,0.0,climate,\n");
            }
            write(dir, "weather_daily.csv", w.toString());
            write(dir, "events.csv", """
                    route,date_from,date_to,days,factor,title,source_url
                    7,2025-11-01,2025-11-14,weekend,0.75,"Ремонт путей, маршрут укорочен",https://example.org/news
                    """);
            write(dir, "factors.json", """
                    {"weather": {"coef": {"rain_warm": -0.05, "rain_we": -0.08, "snow": -0.06, "heat": -0.02,
                                          "cold": -0.01},
                                 "rain_warm_min_t": 12, "heat_above_t": 20, "cold_below_t": -5},
                     "formula": "exp(...)",
                     "limits": {"temp_delta": [-15, 15], "precip_mm": [0, 20], "snow_cm": [0, 5],
                                "event_pct": [-100, 100], "season_pct": [-30, 30]},
                     "presets": [{"id": "snowfall", "title": "Сильный снегопад", "temp_delta": -5, "precip_mm": 0,
                                  "snow_cm": 10, "event_pct": 0, "season_pct": 0}],
                     "note": "test"}
                    """);
            write(dir, "metrics.json", """
                    {"model": {"name": "test", "description": "", "features": []},
                     "backtests": [{"name": "1 месяц", "origin": "2025-09-30", "horizon_days": 31, "wape_score": 0.8}],
                     "by_route": [], "external_effects": [], "extra": true}
                    """);
            return dir;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static void write(Path dir, String name, String content) throws IOException {
        Path p = dir.resolve(name);
        Files.writeString(p, content, StandardCharsets.UTF_8);
        p.toFile().deleteOnExit();
    }
}
