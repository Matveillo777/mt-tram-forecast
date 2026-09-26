package ru.tramforecast.forecast;

import io.swagger.v3.oas.annotations.Parameter;

/** Корректирующие коэффициенты сценария, границы берутся из factors.json. */
public record CorrectionParams(
        @Parameter(description = "Отклонение температуры от нормы, градусы")
        String tempDelta,
        @Parameter(description = "Осадки, мм")
        String precipMm,
        @Parameter(description = "Снег, см")
        String snowCm,
        @Parameter(description = "Поправка на событие, %")
        String eventPct,
        @Parameter(description = "Сезонная поправка, %")
        String seasonPct) {
}
