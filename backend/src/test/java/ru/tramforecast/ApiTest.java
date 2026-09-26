package ru.tramforecast;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webtestclient.autoconfigure.AutoConfigureWebTestClient;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.WebTestClient;
import org.springframework.web.reactive.function.BodyInserters;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import ru.tramforecast.data.DataStore;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.assertj.core.api.Assertions.within;

@SpringBootTest
@AutoConfigureWebTestClient
class ApiTest {

    static final Path DATA = TestData.create();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        registry.add("app.data-dir", DATA::toString);
        registry.add("app.today", () -> "2025-11-01");
        registry.add("app.live.demo", () -> "false");
    }

    @Autowired
    WebTestClient client;

    private WebTestClient.BodyContentSpec get(String uri) {
        return client.get().uri(uri).exchange().expectStatus().isOk()
                .expectHeader().contentTypeCompatibleWith(MediaType.APPLICATION_JSON).expectBody();
    }

    private WebTestClient.BodyContentSpec problem(String uri, int status) {
        return client.get().uri(uri).exchange().expectStatus().isEqualTo(status)
                .expectHeader().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON).expectBody()
                .jsonPath("$.status").isEqualTo(status);
    }

    @Test
    void dayHorizonByHourOverAllRoutes() {
        // час 8: (7+8) + (17+8) + (50+8) = 98; сутки: сумма (74 + 3h) = 2604
        get("/api/v1/forecast")
                .jsonPath("$.horizon").isEqualTo("day")
                .jsonPath("$.from").isEqualTo("2025-11-01")
                .jsonPath("$.to").isEqualTo("2025-11-01")
                .jsonPath("$.granularity").isEqualTo("hour")
                .jsonPath("$.routes.length()").isEqualTo(3)
                .jsonPath("$.stop").doesNotExist()
                .jsonPath("$.multiplier").isEqualTo(1.0)
                .jsonPath("$.series.length()").isEqualTo(24)
                .jsonPath("$.series[8].t").isEqualTo("2025-11-01T08:00")
                .jsonPath("$.series[8].p10").isEqualTo(49.0)
                .jsonPath("$.series[8].p50").isEqualTo(98.0)
                .jsonPath("$.series[8].p90").isEqualTo(196.0)
                .jsonPath("$.series[8].value").isEqualTo(98.0)
                .jsonPath("$.total.p50").isEqualTo(2604.0)
                .jsonPath("$.total.value").isEqualTo(2604.0);
    }

    @Test
    void monthAndYearHorizons() {
        // маршрут 17 за сутки: сумма (17 + h) = 684
        get("/api/v1/forecast?horizon=month&route=17")
                .jsonPath("$.granularity").isEqualTo("day")
                .jsonPath("$.to").isEqualTo("2025-11-30")
                .jsonPath("$.series.length()").isEqualTo(30)
                .jsonPath("$.series[0].t").isEqualTo("2025-11-01")
                .jsonPath("$.series[0].p50").isEqualTo(684.0)
                .jsonPath("$.total.p50").isEqualTo(684.0 * 30);
        // год обрезается по концу прогноза
        get("/api/v1/forecast?horizon=year&route=17")
                .jsonPath("$.granularity").isEqualTo("month")
                .jsonPath("$.to").isEqualTo("2026-01-31")
                .jsonPath("$.series.length()").isEqualTo(3)
                .jsonPath("$.series[1].t").isEqualTo("2025-12")
                .jsonPath("$.series[1].p50").isEqualTo(684.0 * 31)
                .jsonPath("$.series[2].t").isEqualTo("2026-01");
        get("/api/v1/forecast?horizon=year&granularity=day")
                .jsonPath("$.series.length()").isEqualTo(92);
    }

    @Test
    void hourWindowAndRouteList() {
        // часы 8-9 маршрутов 7 и 17: (15 + 25) + (16 + 26) = 82
        get("/api/v1/forecast?route=7,17&from=2025-11-02&to=2025-11-03&hourFrom=8&hourTo=9&granularity=day")
                .jsonPath("$.routes[0]").isEqualTo(7)
                .jsonPath("$.routes[1]").isEqualTo(17)
                .jsonPath("$.series.length()").isEqualTo(2)
                .jsonPath("$.series[1].t").isEqualTo("2025-11-03")
                .jsonPath("$.series[1].p50").isEqualTo(82.0);
        get("/api/v1/forecast?route=17&hourFrom=22&hourTo=23")
                .jsonPath("$.series.length()").isEqualTo(2)
                .jsonPath("$.series[0].t").isEqualTo("2025-11-01T22:00");
    }

    @Test
    void stopShareMultipliesEachHour() {
        get("/api/v1/forecast?route=17&stop=s3")
                .jsonPath("$.stop").isEqualTo("s3")
                .jsonPath("$.series[8].p50").isEqualTo(12.5)
                .jsonPath("$.total.p50").isEqualTo(342.0);
    }

    private static JsonNode json(WebTestClient.BodyContentSpec body) {
        return JsonMapper.builder().build().readTree(body.returnResult().getResponseBody());
    }

    /** Прогноз маршрута 17 на один день; p50 за сутки 684, в 8 часов 25. */
    private JsonNode day17(String date, String corrections) {
        return json(get("/api/v1/forecast?route=17&from=" + date + "&to=" + date + "&granularity=day&" + corrections));
    }

    @Test
    void weatherCorrectionsFollowModelRulesPerDay() {
        // 5 ноября - среда, 4 °C: в будни дождь влияет только при t >= 12, поэтому поправки нет совсем
        JsonNode workday = day17("2025-11-05", "precipMm=12");
        assertThat(workday.path("multiplier").asDouble()).isEqualTo(1.0);
        assertThat(workday.at("/total/value").asDouble()).isEqualTo(684.0);
        assertThat(workday.at("/factor_effects/precip").asDouble()).isEqualTo(1.0);

        // суббота и праздник: коэффициент дождя нерабочего дня, дневной дождь 1 мм заменяется на 12
        double weekend = Math.exp(-0.08 * (Math.log(13) - Math.log(2)));
        for (String date : List.of("2025-11-08", "2025-11-04")) {
            JsonNode r = day17(date, "precipMm=12");
            assertThat(r.path("multiplier").asDouble()).isCloseTo(weekend, within(1e-4));
            assertThat(r.at("/total/p50").asDouble()).isCloseTo(684 * weekend, within(0.051));
            assertThat(r.at("/total/value").asDouble()).isEqualTo(r.at("/total/p50").asDouble());
        }
        // почасовые p10/p50/p90 правятся одним множителем дня
        get("/api/v1/forecast?route=17&from=2025-11-08&precipMm=12")
                .jsonPath("$.series[8].p10").isEqualTo(round1(12.5 * weekend))
                .jsonPath("$.series[8].p50").isEqualTo(round1(25 * weekend))
                .jsonPath("$.series[8].p90").isEqualTo(round1(50 * weekend))
                .jsonPath("$.series[8].value").isEqualTo(round1(25 * weekend));

        // среда-суббота: правится только суббота, итоговый множитель - среднее с весами дней
        JsonNode week = json(get("/api/v1/forecast?route=17&from=2025-11-05&to=2025-11-08&granularity=day&precipMm=12"));
        assertThat(week.at("/series/0/value").asDouble()).isEqualTo(684.0);
        assertThat(week.at("/series/2/value").asDouble()).isEqualTo(684.0);
        assertThat(week.at("/series/3/value").asDouble()).isCloseTo(684 * weekend, within(0.051));
        assertThat(week.path("multiplier").asDouble()).isCloseTo((3 + weekend) / 4, within(1e-4));

        // -15 °C: t = -11, на 6 градусов ниже порога мороза -5
        assertThat(day17("2025-11-05", "tempDelta=-15").path("multiplier").asDouble())
                .isCloseTo(Math.exp(-0.01 * 6), within(1e-4));
        // +15 °C в будни: t = 19 >= 12, и тот же дневной дождь 1 мм начинает снижать спрос; до жары (20) не дошли
        assertThat(day17("2025-11-05", "tempDelta=15").path("multiplier").asDouble())
                .isCloseTo(Math.exp(-0.05 * Math.log(2)), within(1e-4));
        // снег: 0 -> 5 см
        assertThat(day17("2025-11-05", "snowCm=5").path("multiplier").asDouble())
                .isCloseTo(Math.exp(-0.06 * Math.log(6)), within(1e-4));
    }

    @Test
    void factorEffectsAreConsistent() {
        JsonNode none = day17("2025-11-05", "");
        assertThat(none.path("multiplier").asDouble()).isEqualTo(1.0);
        none.path("factor_effects").properties().forEach(e -> assertThat(e.getValue().asDouble()).isEqualTo(1.0));

        JsonNode r = day17("2025-11-05", "tempDelta=-15&snowCm=5&eventPct=20&seasonPct=-10");
        JsonNode fx = r.path("factor_effects");
        assertThat(fx.path("temp").asDouble()).isCloseTo(Math.exp(-0.06), within(1e-4));
        assertThat(fx.path("precip").asDouble()).isEqualTo(1.0);
        assertThat(fx.path("snow").asDouble()).isCloseTo(Math.exp(-0.06 * Math.log(6)), within(1e-4));
        assertThat(fx.path("event").asDouble()).isEqualTo(1.2);
        assertThat(fx.path("season").asDouble()).isEqualTo(0.9);
        // мороз и снег - независимые признаки, поэтому в один день факторы перемножаются
        double product = fx.path("temp").asDouble() * fx.path("snow").asDouble() * 1.2 * 0.9;
        assertThat(r.path("multiplier").asDouble()).isCloseTo(product, within(1e-3));
        assertThat(r.at("/total/value").asDouble()).isCloseTo(684 * r.path("multiplier").asDouble(), within(0.1));

        get("/api/v1/forecast?eventPct=-100").jsonPath("$.total.value").isEqualTo(0.0)
                .jsonPath("$.factor_effects.event").isEqualTo(0.0);
    }

    @Test
    void correctionsReachMapDispatchAndExport() {
        double weekend = Math.exp(-0.08 * (Math.log(13) - Math.log(2)));
        get("/api/v1/map?date=2025-11-08&hour=8&precipMm=12")
                .jsonPath("$.routes[?(@.route == 17)].value").isEqualTo(List.of(round1(25 * weekend)));
        get("/api/v1/map?date=2025-11-05&hour=8&precipMm=12")
                .jsonPath("$.multiplier").isEqualTo(1.0)
                .jsonPath("$.routes[?(@.route == 17)].value").isEqualTo(List.of(25.0));
        // факт истории не правится
        get("/api/v1/map?date=2025-10-04&hour=8&precipMm=12")
                .jsonPath("$.multiplier").isEqualTo(1.0)
                .jsonPath("$.routes[?(@.route == 17)].value").isEqualTo(List.of(178.0));
        get("/api/v1/dispatch?route=17&date=2025-11-08&precipMm=12")
                .jsonPath("$.hours[8].p50").isEqualTo(round1(25 * weekend))
                .jsonPath("$.hours[8].p90").isEqualTo(round1(50 * weekend));
        String csv = client.get().uri("/api/v1/export?route=17&from=2025-11-08&precipMm=12").exchange()
                .expectStatus().isOk().expectBody(String.class).returnResult().getResponseBody();
        String p50 = String.valueOf(round1(25 * weekend)).replace('.', ',');
        assertThat(csv).contains("2025-11-08T08:00;17;;" + String.valueOf(round1(12.5 * weekend)).replace('.', ',')
                + ";" + p50 + ";" + String.valueOf(round1(50 * weekend)).replace('.', ',') + ";" + p50);
    }

    private static double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }

    @Test
    void badParametersGive400ProblemJson() {
        problem("/api/v1/forecast?horizon=week", 400)
                .jsonPath("$.detail").value(d -> assertThat((String) d).contains("horizon").contains("day, month, year"));
        problem("/api/v1/forecast?from=2027-01-01", 400)
                .jsonPath("$.detail").value(d -> assertThat((String) d).contains("границы прогноза"));
        problem("/api/v1/forecast?from=2025-11-10&to=2025-11-05", 400);
        problem("/api/v1/forecast?from=01.11.2025", 400)
                .jsonPath("$.detail").value(d -> assertThat((String) d).contains("ГГГГ-ММ-ДД"));
        problem("/api/v1/forecast?hourFrom=25", 400);
        problem("/api/v1/forecast?hourFrom=9&hourTo=3", 400);
        problem("/api/v1/forecast?tempDelta=99", 400)
                .jsonPath("$.detail").value(d -> assertThat((String) d).contains("от -15 до 15"));
        problem("/api/v1/forecast?precipMm=25", 400)
                .jsonPath("$.detail").value(d -> assertThat((String) d).contains("precipMm").contains("от 0 до 20"));
        problem("/api/v1/map?snowCm=6", 400)
                .jsonPath("$.detail").value(d -> assertThat((String) d).contains("snowCm").contains("от 0 до 5"));
        problem("/api/v1/forecast?granularity=week", 400);
        problem("/api/v1/forecast?stop=s1", 400);
        problem("/api/v1/forecast?route=abc", 400);
        problem("/api/v1/history?from=2025-11-05", 400);
        problem("/api/v1/export?format=pdf", 400);
    }

    @Test
    void unknownRouteOrStopGive404() {
        problem("/api/v1/forecast?route=99", 404)
                .jsonPath("$.detail").value(d -> assertThat((String) d).startsWith("Маршрут 99 не найден"));
        problem("/api/v1/routes/99", 404);
        problem("/api/v1/forecast?route=17&stop=zzz", 404);
        problem("/api/v1/forecast?route=50&stop=x", 404)
                .jsonPath("$.detail").value(d -> assertThat((String) d).contains("нет данных об остановках"));
        problem("/api/v1/no-such-endpoint", 404)
                .jsonPath("$.detail").value(d -> assertThat((String) d).startsWith("Такого адреса нет"));
    }

    @Test
    void historyAggregation() {
        // маршрут 17: сумма (170 + h) = 4356 в сутки
        get("/api/v1/history?route=17&from=2025-10-01&to=2025-10-02")
                .jsonPath("$.granularity").isEqualTo("day")
                .jsonPath("$.series[0].actual").isEqualTo(4356.0)
                .jsonPath("$.total.actual").isEqualTo(8712.0);
        get("/api/v1/history?route=7&stop=a2&from=2025-10-01&to=2025-10-01")
                .jsonPath("$.granularity").isEqualTo("hour")
                .jsonPath("$.series[2].actual").isEqualTo(54.0);
        get("/api/v1/history").jsonPath("$.from").isEqualTo("2025-10-02").jsonPath("$.to").isEqualTo("2025-10-31");
    }

    @Test
    void mapUsesForecastOrHistory() {
        get("/api/v1/map?date=2025-11-01&hour=8")
                .jsonPath("$.kind").isEqualTo("forecast")
                .jsonPath("$.hour").isEqualTo(8)
                .jsonPath("$.routes[?(@.route == 17)].value").isEqualTo(List.of(25.0))
                .jsonPath("$.routes[?(@.route == 17)].stops[2].value").isEqualTo(List.of(12.5))
                .jsonPath("$.routes[2].route").isEqualTo(50)
                .jsonPath("$.routes[2].stops.length()").isEqualTo(0);
        get("/api/v1/map?date=2025-11-01&hour=8&eventPct=100")
                .jsonPath("$.routes[?(@.route == 17)].value").isEqualTo(List.of(50.0));
        get("/api/v1/map?date=2025-10-01&hour=8")
                .jsonPath("$.kind").isEqualTo("history")
                .jsonPath("$.routes[?(@.route == 17)].value").isEqualTo(List.of(178.0));
        get("/api/v1/map?date=2025-11-01").jsonPath("$.hour").doesNotExist();
        problem("/api/v1/map?date=2024-01-01", 400);
    }

    @Test
    void exportCsvAndXlsx() {
        byte[] csv = client.get().uri("/api/v1/export?format=csv&route=17&stop=s3").exchange()
                .expectStatus().isOk()
                .expectHeader().contentTypeCompatibleWith("text/csv")
                .expectHeader().value("Content-Disposition",
                        v -> assertThat(v).startsWith("attachment").contains("forecast_2025-11-01_2025-11-01.csv"))
                .expectBody().returnResult().getResponseBody();
        String text = new String(csv, StandardCharsets.UTF_8);
        assertThat(text).startsWith("﻿period;route;stop;p10;p50;p90;value\r\n");
        assertThat(text.split("\r\n")).hasSize(25).contains("2025-11-01T08:00;17;s3;6,3;12,5;25,0;12,5");

        byte[] xlsx = client.get().uri("/api/v1/export?format=xlsx&horizon=month&route=7,17").exchange()
                .expectStatus().isOk()
                .expectHeader().contentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                .expectHeader().value("Content-Disposition", v -> assertThat(v).contains(".xlsx"))
                .expectBody().returnResult().getResponseBody();
        assertThat(xlsx).isNotNull();
        assertThat(new String(xlsx, 0, 2, StandardCharsets.US_ASCII)).isEqualTo("PK");
    }

    @Test
    void dispatchMath() {
        // capacity 10, peakShare 0.5, план 3 рейса: час 0 p90 = 34 -> 17 пасс. -> 2 рейса, 30 мин
        get("/api/v1/dispatch?route=17&date=2025-11-01&capacity=10&peakShare=0.5&plannedPerHour=3")
                .jsonPath("$.route").isEqualTo(17)
                .jsonPath("$.hours.length()").isEqualTo(24)
                .jsonPath("$.hours[0].p50").isEqualTo(17.0)
                .jsonPath("$.hours[0].p90").isEqualTo(34.0)
                .jsonPath("$.hours[0].peak_load").isEqualTo(17.0)
                .jsonPath("$.hours[0].trips_needed").isEqualTo(2)
                .jsonPath("$.hours[0].interval_min").isEqualTo(30.0)
                .jsonPath("$.hours[0].planned").isEqualTo(3)
                .jsonPath("$.hours[0].risk").isEqualTo("ok")
                .jsonPath("$.hours[5].risk").isEqualTo("tight")
                .jsonPath("$.hours[20].trips_needed").isEqualTo(4)
                .jsonPath("$.hours[20].interval_min").isEqualTo(15.0)
                .jsonPath("$.hours[20].risk").isEqualTo("overload");
        get("/api/v1/dispatch").jsonPath("$.capacity").isEqualTo(190).jsonPath("$.planned_per_hour").isEqualTo(8);
        problem("/api/v1/dispatch?capacity=0", 400);
        problem("/api/v1/dispatch?route=7,17", 400);
        problem("/api/v1/dispatch?peakShare=abc", 400);
        problem("/api/v1/dispatch?date=2025-10-01", 400);
    }

    @Test
    void ingestCsvNormalizesAndCounts() {
        String csv = """
                tran_no;tran_date_time;validation_result;ngpt_route
                1;2025-11-05 08:15:00;1;17 трамвай
                2;2025-11-05 08:20:00;1;"17 трамвай"
                3;2025-11-05 09:00:00;0;7 трамвай
                4;2025-11-05 09:00:00;1;99 трамвай
                5;2025-11-05 25:00:00;1;7 трамвай
                6;2025-11-05 10:00:00;1;17 автобус
                """;
        client.post().uri("/api/v1/ingest/validations").contentType(MediaType.parseMediaType("text/csv"))
                .bodyValue(csv).exchange().expectStatus().isOk().expectBody()
                .jsonPath("$.accepted").isEqualTo(3)
                .jsonPath("$.rejected").isEqualTo(3)
                .jsonPath("$.boardings").isEqualTo(2)
                .jsonPath("$.errors.length()").isEqualTo(3)
                .jsonPath("$.errors[0]").value(e -> assertThat((String) e).contains("строка 5").contains("99"));
        get("/api/v1/live?date=2025-11-05")
                .jsonPath("$.demo").isEqualTo(false)
                .jsonPath("$.routes[?(@.route == 17)].hours[8].actual").isEqualTo(List.of(2))
                .jsonPath("$.routes[?(@.route == 17)].hours[8].forecast").isEqualTo(List.of(25.0))
                .jsonPath("$.routes[?(@.route == 17)].actual_total").isEqualTo(List.of(2))
                .jsonPath("$.routes[?(@.route == 7)].actual_total").isEqualTo(List.of(0));

        client.post().uri("/api/v1/ingest/validations").contentType(MediaType.parseMediaType("text/csv"))
                .bodyValue("a;b;c\n1;2;3\n").exchange().expectStatus().isBadRequest()
                .expectBody().jsonPath("$.detail").value(d -> assertThat((String) d).contains("ngpt_route"));
    }

    @Test
    void ingestJsonNormalizesAndCounts() {
        String json = """
                [{"ngpt_route": "7 трамвай", "validation_result": 1, "tran_date_time": "2025-11-06 07:59:59"},
                 {"ngpt_route": "7", "validation_result": "1", "tran_date_time": "2025-11-06T07:00:00"},
                 {"ngpt_route": "7 трамвай", "validation_result": 1, "tran_date_time": "2025-11-06 07:30:00.123"},
                 {"ngpt_route": "7 трамвай", "validation_result": 3, "tran_date_time": "2025-11-06 07:30:00"},
                 {"ngpt_route": "7 трамвай", "tran_date_time": "2025-11-06 07:30:00"},
                 42]
                """;
        client.post().uri("/api/v1/ingest/validations").contentType(MediaType.APPLICATION_JSON)
                .bodyValue(json).exchange().expectStatus().isOk().expectBody()
                .jsonPath("$.accepted").isEqualTo(4)
                .jsonPath("$.rejected").isEqualTo(2)
                .jsonPath("$.boardings").isEqualTo(3);
        get("/api/v1/live?date=2025-11-06").jsonPath("$.routes[?(@.route == 7)].hours[7].actual").isEqualTo(List.of(3));

        client.post().uri("/api/v1/ingest/validations").contentType(MediaType.APPLICATION_JSON)
                .bodyValue("{not json").exchange().expectStatus().isBadRequest()
                .expectHeader().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON);
        client.post().uri("/api/v1/ingest/validations").contentType(MediaType.APPLICATION_XML)
                .bodyValue("<a/>").exchange().expectStatus().isEqualTo(415);
    }

    @Test
    void ingestEmptyBodyGives400WithAnyContentType() {
        client.post().uri("/api/v1/ingest/validations").exchange().expectStatus().isBadRequest()
                .expectHeader().contentTypeCompatibleWith(MediaType.APPLICATION_PROBLEM_JSON)
                .expectBody().jsonPath("$.detail").value(d -> assertThat((String) d).startsWith("Пустое тело запроса"));
        for (String type : List.of("application/json", "text/csv", "text/plain", "application/xml")) {
            client.post().uri("/api/v1/ingest/validations").contentType(MediaType.parseMediaType(type)).bodyValue("")
                    .exchange().expectStatus().isBadRequest()
                    .expectBody().jsonPath("$.detail").value(d -> assertThat((String) d).startsWith("Пустое тело"));
        }
        // байты без текстового типа (application/octet-stream) читаются как CSV
        byte[] csv = "ngpt_route;validation_result;tran_date_time\n50;1;2025-11-07 10:00:00\n"
                .getBytes(StandardCharsets.UTF_8);
        client.post().uri("/api/v1/ingest/validations").body(BodyInserters.fromValue(csv))
                .exchange().expectStatus().isOk().expectBody().jsonPath("$.boardings").isEqualTo(1);
    }

    @Test
    void referenceEndpoints() {
        get("/api/v1/meta")
                .jsonPath("$.today").isEqualTo("2025-11-01")
                .jsonPath("$.forecast_to").isEqualTo("2026-01-31")
                .jsonPath("$.history_from").isEqualTo("2025-10-01")
                .jsonPath("$.routes").isEqualTo(List.of(7, 17, 50))
                .jsonPath("$.granularities.length()").isEqualTo(3);
        get("/api/v1/routes")
                .jsonPath("$[2].route").isEqualTo(50)
                .jsonPath("$[2].stops_count").isEqualTo(0)
                .jsonPath("$[1].stops_count").isEqualTo(3);
        get("/api/v1/routes/17").jsonPath("$.stops[1].stop_id").isEqualTo("s2").jsonPath("$.extra.any").isEqualTo(1);
        client.get().uri("/api/v1/routes/geojson").exchange().expectStatus().isOk().expectBody()
                .jsonPath("$.type").isEqualTo("FeatureCollection")
                .jsonPath("$.features.length()").isEqualTo(7)
                .jsonPath("$.features[?(@.geometry.type == 'Point')].properties.near_rail").isEqualTo(
                        List.of(false, false, false, true, false));
        get("/api/v1/model").jsonPath("$.backtests[0].wape_score").isEqualTo(0.8);
        get("/api/v1/factors").jsonPath("$.limits.temp_delta[0]").isEqualTo(-15);
        get("/api/v1/calendar?from=2025-11-03&to=2025-11-05")
                .jsonPath("$.length()").isEqualTo(3)
                .jsonPath("$[1].day_type").isEqualTo("holiday")
                .jsonPath("$[1].is_holiday").isEqualTo(1);
        get("/api/v1/weather").jsonPath("$[1].t_mean").isEqualTo(2.1).jsonPath("$[1].snow_cm").doesNotExist();
        get("/api/v1/events").jsonPath("$[0].date_from").isEqualTo("2025-11-01").jsonPath("$[0].factor").isEqualTo(0.75);
    }

    @Test
    void opsEndpoints() {
        client.get().uri("/actuator/health").exchange().expectStatus().isOk()
                .expectBody().jsonPath("$.status").isEqualTo("UP");
        client.get().uri("/v3/api-docs").exchange().expectStatus().isOk()
                .expectBody().jsonPath("$.paths['/api/v1/forecast'].get").exists();
        client.get().uri("/swagger-ui/index.html").exchange().expectStatus().isOk();
        // для проверки CORS нужен полный адрес: без хоста запрос нельзя сравнить с Origin
        client.get().uri("http://localhost/api/v1/forecast").header("Origin", "http://example.org").exchange()
                .expectStatus().isOk()
                .expectHeader().valueEquals("Access-Control-Allow-Origin", "*");
        client.post().uri("http://localhost/api/v1/ingest/validations").header("Origin", "http://example.org")
                .contentType(MediaType.APPLICATION_JSON).bodyValue("[]").exchange()
                .expectStatus().isForbidden();
        client.get().uri("/actuator/prometheus").exchange().expectStatus().isOk()
                .expectBody(String.class).value(s -> assertThat(s).contains("tram_ingest_records_total"));
    }

    @Test
    void liveStreamSendsSnapshots() {
        ServerSentEvent<String> first = client.get().uri("/api/v1/live/stream").accept(MediaType.TEXT_EVENT_STREAM)
                .exchange().expectStatus().isOk()
                .returnResult(new ParameterizedTypeReference<ServerSentEvent<String>>() {
                })
                .getResponseBody().blockFirst(Duration.ofSeconds(5));
        assertThat(first).isNotNull();
        assertThat(first.event()).isEqualTo("snapshot");
        assertThat(first.data()).contains("\"date\":\"2025-11-01\"").contains("\"actual_total\"");
    }

    @Test
    void brokenArtifactStopsStartup() throws Exception {
        Path dir = TestData.create();
        List<String> lines = Files.readAllLines(dir.resolve("forecast_hourly.csv"));
        Files.write(dir.resolve("forecast_hourly.csv"), lines.subList(0, lines.size() - 1));
        assertThatThrownBy(() -> new DataStore(dir.toString(), "2025-11-01", JsonMapper.builder().build()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("forecast_hourly.csv")
                .hasMessageContaining("полная сетка");
    }
}
