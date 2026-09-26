package ru.tramforecast.live;

import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLongArray;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

import ru.tramforecast.data.DataStore;
import ru.tramforecast.data.DataStore.Grid;
import ru.tramforecast.forecast.Params;

import static ru.tramforecast.data.DataStore.HOURS;
import static ru.tramforecast.forecast.ForecastService.round1;

@RestController
@RequestMapping("/api/v1")
public class LiveController {

    public record Hour(int hour, long actual, Double forecast) {
    }

    public record RouteLive(int route, long actualTotal, Double forecastTotal, List<Hour> hours) {
    }

    /** source: demo - счетчики наполняет встроенный демо-поток, ingest - только POST /ingest/validations. */
    public record Live(String date, String updatedAt, boolean demo, String source, String simTime,
                       List<RouteLive> routes) {
    }

    private final IngestService ingest;
    private final DemoStream demo;
    private final DataStore store;
    // один снимок раз в 2 секунды на всех подписчиков, новый подписчик сразу получает последний
    private final Flux<Live> snapshots;

    public LiveController(IngestService ingest, DemoStream demo, DataStore store) {
        this.ingest = ingest;
        this.demo = demo;
        this.store = store;
        this.snapshots = Flux.interval(Duration.ZERO, Duration.ofSeconds(2))
                .onBackpressureDrop()
                .map(i -> snapshot(demo.date()))
                .replay(1)
                .refCount();
    }

    @Operation(summary = "Прием валидаций: CSV датасета (разделитель ;) или JSON-массив записей",
            description = "Посадкой считается запись с validation_result = 1. Маршрут берется из ngpt_route, "
                    + "время из tran_date_time. Тело до 10 МБ.")
    // браузер под Windows отдает .csv как application/vnd.ms-excel, без заголовка тело считается octet-stream
    @PostMapping(value = "/ingest/validations", consumes = {"text/csv", MediaType.TEXT_PLAIN_VALUE,
            "application/vnd.ms-excel", MediaType.APPLICATION_OCTET_STREAM_VALUE})
    public Mono<IngestService.Result> ingestCsv(@RequestBody(required = false) Mono<String> body) {
        return body.defaultIfEmpty("").publishOn(Schedulers.parallel()).map(ingest::csv);
    }

    @Operation(summary = "Прием валидаций в JSON: массив объектов с полями датасета")
    @PostMapping(value = "/ingest/validations", consumes = MediaType.APPLICATION_JSON_VALUE)
    public Mono<IngestService.Result> ingestJson(@RequestBody(required = false) Mono<String> body) {
        return body.defaultIfEmpty("").publishOn(Schedulers.parallel()).map(ingest::json);
    }

    @Operation(summary = "Факт посадок по часам против прогноза p50 на дату")
    @GetMapping("/live")
    public Live live(@Parameter(description = "Дата ГГГГ-ММ-ДД, по умолчанию живая дата демо-потока")
                     @RequestParam(required = false) String date) {
        return snapshot(Params.date("date", date, demo.date()));
    }

    @Operation(summary = "Поток событий snapshot каждые 2 секунды (Server-Sent Events) для живой даты")
    @GetMapping(value = "/live/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public Flux<ServerSentEvent<Live>> stream() {
        return snapshots.onBackpressureLatest()
                .map(live -> ServerSentEvent.builder(live).event("snapshot").build());
    }

    private Live snapshot(LocalDate date) {
        Grid g = store.forecast();
        boolean hasForecast = g.contains(date);
        int day = hasForecast ? g.day(date) : -1;
        AtomicLongArray counts = ingest.counts(date);
        List<RouteLive> routes = new ArrayList<>(store.routes().length);
        for (int r = 0; r < store.routes().length; r++) {
            List<Hour> hours = new ArrayList<>(HOURS);
            long actualTotal = 0;
            double forecastTotal = 0;
            for (int h = 0; h < HOURS; h++) {
                long actual = counts == null ? 0 : counts.get(r * HOURS + h);
                Double forecast = hasForecast ? round1(g.cols()[1][g.index(r, day, h)]) : null;
                hours.add(new Hour(h, actual, forecast));
                actualTotal += actual;
                forecastTotal += forecast == null ? 0 : forecast;
            }
            routes.add(new RouteLive(store.routes()[r].route(), actualTotal,
                    hasForecast ? round1(forecastTotal) : null, hours));
        }
        boolean isDemo = demo.enabled() && date.equals(demo.date());
        return new Live(date.toString(), ingest.updatedAt().atOffset(ZoneOffset.UTC).toString(), isDemo,
                isDemo ? "demo" : "ingest", isDemo ? demo.simTime() : null, routes);
    }
}
