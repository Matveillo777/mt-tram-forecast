package ru.tramforecast.forecast;

import io.swagger.v3.oas.annotations.Parameter;

/** Параметры /forecast и /export как пришли в запросе, разбираются в ForecastService. */
public record ForecastParams(
        @Parameter(description = "Горизонт: day, month, year. По умолчанию day")
        String horizon,
        @Parameter(description = "Начало периода ГГГГ-ММ-ДД включительно, по умолчанию сегодня")
        String from,
        @Parameter(description = "Конец периода ГГГГ-ММ-ДД включительно, по умолчанию по горизонту")
        String to,
        @Parameter(description = "Первый час суток окна, 0-23")
        String hourFrom,
        @Parameter(description = "Последний час суток окна, 0-23")
        String hourTo,
        @Parameter(description = "Маршруты через запятую, пусто - все", example = "17,25")
        String route,
        @Parameter(description = "stop_id остановки, нужен ровно один маршрут")
        String stop,
        @Parameter(description = "Детализация: hour, day, month. По умолчанию зависит от горизонта")
        String granularity) {
}
