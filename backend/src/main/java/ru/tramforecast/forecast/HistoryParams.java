package ru.tramforecast.forecast;

import io.swagger.v3.oas.annotations.Parameter;

public record HistoryParams(
        @Parameter(description = "Начало периода ГГГГ-ММ-ДД, по умолчанию 30 дней до конца истории")
        String from,
        @Parameter(description = "Конец периода ГГГГ-ММ-ДД, по умолчанию последний день истории")
        String to,
        @Parameter(description = "Первый час суток окна, 0-23")
        String hourFrom,
        @Parameter(description = "Последний час суток окна, 0-23")
        String hourTo,
        @Parameter(description = "Маршруты через запятую, пусто - все")
        String route,
        @Parameter(description = "stop_id остановки, нужен ровно один маршрут")
        String stop,
        @Parameter(description = "Детализация: hour, day, month. По умолчанию по длине периода")
        String granularity) {
}
