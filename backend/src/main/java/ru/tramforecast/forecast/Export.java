package ru.tramforecast.forecast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.List;

import org.dhatim.fastexcel.Workbook;
import org.dhatim.fastexcel.Worksheet;

import ru.tramforecast.forecast.ForecastService.ExportRow;

/** Выгрузка прогноза в CSV (для Excel: ";" и BOM) и XLSX с одинаковыми колонками. */
final class Export {

    static final String[] HEADER = {"period", "route", "stop", "p10", "p50", "p90", "value"};

    private Export() {
    }

    static byte[] csv(List<ExportRow> rows) {
        StringBuilder sb = new StringBuilder(rows.size() * 48 + 64);
        sb.append('﻿').append(String.join(";", HEADER)).append("\r\n");
        for (ExportRow r : rows) {
            sb.append(r.period()).append(';').append(r.route()).append(';')
                    .append(r.stop() == null ? "" : r.stop()).append(';');
            decimal(sb, r.p10()).append(';');
            decimal(sb, r.p50()).append(';');
            decimal(sb, r.p90()).append(';');
            decimal(sb, r.value()).append("\r\n");
        }
        return sb.toString().getBytes(StandardCharsets.UTF_8);
    }

    static byte[] xlsx(List<ExportRow> rows) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(rows.size() * 24 + 4096);
        try {
            Workbook wb = new Workbook(out, "tram-forecast", "1.0");
            Worksheet ws = wb.newWorksheet("Прогноз");
            for (int c = 0; c < HEADER.length; c++) {
                ws.value(0, c, HEADER[c]);
            }
            ws.range(0, 0, 0, HEADER.length - 1).style().bold().set();
            ws.freezePane(0, 1);
            int i = 1;
            for (ExportRow r : rows) {
                ws.value(i, 0, r.period());
                ws.value(i, 1, r.route());
                if (r.stop() != null) {
                    ws.value(i, 2, r.stop());
                }
                ws.value(i, 3, r.p10());
                ws.value(i, 4, r.p50());
                ws.value(i, 5, r.p90());
                ws.value(i, 6, r.value());
                i++;
            }
            wb.finish();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        return out.toByteArray();
    }

    // Excel с русской локалью ждет запятую в дробях, иначе "12.5" превращается в дату
    private static StringBuilder decimal(StringBuilder sb, double v) {
        long tenths = Math.round(v * 10);
        return sb.append(tenths / 10).append(',').append(Math.abs(tenths % 10));
    }
}
