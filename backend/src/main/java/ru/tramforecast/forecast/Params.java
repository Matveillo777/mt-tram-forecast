package ru.tramforecast.forecast;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.List;

import ru.tramforecast.ApiException;

/** Разбор строковых параметров запроса с русскими сообщениями об ошибках. */
public final class Params {

    private Params() {
    }

    public static boolean blank(String s) {
        return s == null || s.isBlank();
    }

    public static String oneOf(String name, String value, String def, List<String> allowed) {
        if (blank(value)) {
            return def;
        }
        String v = value.trim();
        if (!allowed.contains(v)) {
            throw ApiException.badRequest("Параметр " + name + ": допустимые значения " + String.join(", ", allowed)
                    + ", получено '" + v + "'");
        }
        return v;
    }

    public static LocalDate date(String name, String value, LocalDate def) {
        if (blank(value)) {
            return def;
        }
        try {
            return LocalDate.parse(value.trim());
        } catch (DateTimeParseException e) {
            throw ApiException.badRequest("Параметр " + name + ": ожидается дата в формате ГГГГ-ММ-ДД, получено '"
                    + value.trim() + "'");
        }
    }

    public static int integer(String name, String value, int def, int min, int max) {
        if (blank(value)) {
            return def;
        }
        try {
            int v = Integer.parseInt(value.trim());
            if (v >= min && v <= max) {
                return v;
            }
        } catch (NumberFormatException ignored) {
            // ниже общее сообщение
        }
        throw ApiException.badRequest("Параметр " + name + ": ожидается целое число от " + min + " до " + max
                + ", получено '" + value.trim() + "'");
    }

    public static double number(String name, String value, double def, double min, double max) {
        if (blank(value)) {
            return def;
        }
        try {
            double v = Double.parseDouble(value.trim());
            if (Double.isFinite(v) && v >= min && v <= max) {
                return v;
            }
        } catch (NumberFormatException ignored) {
            // ниже общее сообщение
        }
        throw ApiException.badRequest("Параметр " + name + ": ожидается число от " + fmt(min) + " до " + fmt(max)
                + ", получено '" + value.trim() + "'");
    }

    private static String fmt(double v) {
        return v == Math.rint(v) ? String.valueOf((long) v) : String.valueOf(v);
    }
}
