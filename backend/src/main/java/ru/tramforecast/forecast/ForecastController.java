package ru.tramforecast.forecast;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.List;
import java.util.function.Function;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.Parameter;
import org.springdoc.core.annotations.ParameterObject;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;
import tools.jackson.databind.JsonNode;

import ru.tramforecast.ApiException;
import ru.tramforecast.data.DataStore;
import ru.tramforecast.data.DataStore.CalendarDay;
import ru.tramforecast.data.DataStore.Event;
import ru.tramforecast.data.DataStore.Route;
import ru.tramforecast.data.DataStore.WeatherDay;

@RestController
@RequestMapping("/api/v1")
public class ForecastController {

    private static final MediaType XLSX =
            MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    public record Meta(String today, String forecastFrom, String forecastTo, String historyFrom, String historyTo,
                       int[] routes, List<String> horizons, List<String> granularities) {
    }

    public record RouteInfo(int route, String name, String color, int stopsCount) {
    }

    private final DataStore store;
    private final ForecastService service;

    public ForecastController(DataStore store, ForecastService service) {
        this.store = store;
        this.service = service;
    }

    @Operation(summary = "Границы данных, список маршрутов и допустимые значения параметров")
    @GetMapping("/meta")
    public Meta meta() {
        return new Meta(store.today().toString(), store.forecast().from().toString(), store.forecast().to().toString(),
                store.history().from().toString(), store.history().to().toString(),
                Arrays.stream(store.routes()).mapToInt(Route::route).toArray(),
                ForecastService.HORIZONS, ForecastService.GRANULARITIES);
    }

    @Operation(summary = "Маршруты")
    @GetMapping("/routes")
    public List<RouteInfo> routes() {
        return Arrays.stream(store.routes())
                .map(r -> new RouteInfo(r.route(), r.name(), r.color(), r.stopIds().length))
                .toList();
    }

    @Operation(summary = "Трассы и остановки всех маршрутов в GeoJSON")
    @GetMapping(value = "/routes/geojson", produces = {"application/geo+json", "application/json"})
    public JsonNode geojson() {
        return store.geojson();
    }

    @Operation(summary = "Маршрут целиком: трасса и остановки")
    @GetMapping("/routes/{route}")
    public JsonNode route(@PathVariable String route) {
        int number;
        try {
            number = Integer.parseInt(route.trim());
        } catch (NumberFormatException e) {
            throw ApiException.badRequest("Номер маршрута должен быть целым числом, получено '" + route + "'");
        }
        return store.routes()[service.routeIndex(number)].json();
    }

    @Operation(summary = "Прогноз посадок с агрегацией по маршрутам, остановке, часам и периоду",
            description = "Поправки сценария считаются для каждого дня по правилам модели (погода дня, тип дня) "
                    + "и применяются к почасовым p10, p50, p90 до агрегации; value = p50 с поправками. "
                    + "multiplier - итоговый множитель за выборку, factor_effects - то же для каждого фактора отдельно")
    @GetMapping("/forecast")
    public ForecastService.Forecast forecast(@ParameterObject ForecastParams params,
                                             @ParameterObject CorrectionParams corrections) {
        return service.forecast(params, corrections);
    }

    @Operation(summary = "Фактические посадки за период истории")
    @GetMapping("/history")
    public ForecastService.History history(@ParameterObject HistoryParams params) {
        return service.history(params);
    }

    @Operation(summary = "Нагрузка маршрутов и остановок на дату и час для карты")
    @GetMapping("/map")
    public ForecastService.MapView map(
            @Parameter(description = "Дата ГГГГ-ММ-ДД, по умолчанию сегодня") @RequestParam(required = false) String date,
            @Parameter(description = "Час 0-23, без него - сумма за сутки") @RequestParam(required = false) String hour,
            @ParameterObject CorrectionParams corrections) {
        return service.map(date, hour, corrections);
    }

    @Operation(summary = "Выгрузка прогноза в CSV или XLSX", description = "Параметры те же, что у /forecast")
    @GetMapping("/export")
    public Mono<ResponseEntity<byte[]>> export(
            @Parameter(description = "csv или xlsx, по умолчанию csv") @RequestParam(required = false) String format,
            @ParameterObject ForecastParams params,
            @ParameterObject CorrectionParams corrections) {
        String fmt = Params.oneOf("format", format, "csv", List.of("csv", "xlsx"));
        // сборка файла на год почасовых строк занимает десятки миллисекунд - не держим event loop
        return Mono.fromCallable(() -> {
            ForecastService.ExportData data = service.exportRows(params, corrections);
            boolean csv = fmt.equals("csv");
            byte[] body = csv ? Export.csv(data.rows()) : Export.xlsx(data.rows());
            String name = "forecast_" + data.from() + "_" + data.to() + "." + fmt;
            return ResponseEntity.ok()
                    .contentType(csv ? new MediaType("text", "csv", StandardCharsets.UTF_8) : XLSX)
                    .header(HttpHeaders.CONTENT_DISPOSITION,
                            ContentDisposition.attachment().filename(name).build().toString())
                    .body(body);
        }).subscribeOn(Schedulers.boundedElastic());
    }

    @Operation(summary = "Расчет выпуска: сколько рейсов нужно в каждый час и где риск переполнения")
    @GetMapping("/dispatch")
    public ForecastService.Dispatch dispatch(
            @Parameter(description = "Номер маршрута, по умолчанию 17") @RequestParam(required = false) String route,
            @Parameter(description = "Дата ГГГГ-ММ-ДД, по умолчанию сегодня") @RequestParam(required = false) String date,
            @Parameter(description = "Вместимость вагона, пассажиров (1-1000), по умолчанию 190")
            @RequestParam(required = false) String capacity,
            @Parameter(description = "Доля часовых посадок на самом загруженном перегоне (0.01-1), по умолчанию 0.35")
            @RequestParam(required = false) String peakShare,
            @Parameter(description = "Рейсов в час по расписанию (0-60), по умолчанию 8")
            @RequestParam(required = false) String plannedPerHour,
            @ParameterObject CorrectionParams corrections) {
        return service.dispatch(route, date, capacity, peakShare, plannedPerHour, corrections);
    }

    @Operation(summary = "Метрики качества модели (metrics.json)")
    @GetMapping("/model")
    public JsonNode model() {
        return store.metricsJson();
    }

    @Operation(summary = "Коэффициенты и границы поправок, готовые сценарии (factors.json)")
    @GetMapping("/factors")
    public JsonNode factors() {
        return store.factorsJson();
    }

    @Operation(summary = "Производственный календарь: тип дня, праздники, каникулы")
    @GetMapping("/calendar")
    public List<CalendarDay> calendar(@RequestParam(required = false) String from,
                                      @RequestParam(required = false) String to) {
        return between(store.calendar(), CalendarDay::date, from, to);
    }

    @Operation(summary = "Погода по дням: наблюдения и климатическая норма")
    @GetMapping("/weather")
    public List<WeatherDay> weather(@RequestParam(required = false) String from,
                                    @RequestParam(required = false) String to) {
        return between(store.weather(), WeatherDay::date, from, to);
    }

    @Operation(summary = "События, учтенные в прогнозе: ремонты, перекрытия")
    @GetMapping("/events")
    public List<Event> events() {
        return store.events();
    }

    private static <T> List<T> between(List<T> rows, Function<T, String> date, String from,
                                       String to) {
        String lo = Params.blank(from) ? "" : Params.date("from", from, null).toString();
        String hi = Params.blank(to) ? "9999" : Params.date("to", to, null).toString();
        if (lo.compareTo(hi) > 0) {
            throw ApiException.badRequest("Дата from (" + lo + ") позже даты to (" + hi + ")");
        }
        return rows.stream().filter(r -> date.apply(r).compareTo(lo) >= 0 && date.apply(r).compareTo(hi) <= 0)
                .toList();
    }
}
