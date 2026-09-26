package ru.tramforecast.data;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** Минимальный CSV: разделитель задается, поддерживаются кавычки и "" внутри значения. */
public final class Csv {

    private Csv() {
    }

    public record Table(String file, String[] header, List<String[]> rows, int[] lines) {

        public int col(String name) {
            for (int i = 0; i < header.length; i++) {
                if (header[i].equals(name)) {
                    return i;
                }
            }
            throw new IllegalStateException("Артефакт " + file + ": нет колонки '" + name + "'");
        }
    }

    public static Table read(Path path, char sep) throws IOException {
        String file = path.getFileName().toString();
        List<String> lines = Files.readAllLines(path, StandardCharsets.UTF_8);
        if (lines.isEmpty()) {
            throw new IllegalStateException("Артефакт " + file + " пустой");
        }
        String[] header = split(stripBom(lines.get(0)), sep);
        for (int i = 0; i < header.length; i++) {
            header[i] = header[i].trim();
        }
        List<String[]> rows = new ArrayList<>(lines.size());
        int[] lineNumbers = new int[lines.size()];
        for (int i = 1; i < lines.size(); i++) {
            String line = lines.get(i);
            if (line.isBlank()) {
                continue;
            }
            String[] row = split(line, sep);
            if (row.length < header.length) {
                throw new IllegalStateException("Артефакт " + file + ", строка " + (i + 1)
                        + ": ожидается " + header.length + " колонок, найдено " + row.length);
            }
            lineNumbers[rows.size()] = i + 1;
            rows.add(row);
        }
        return new Table(file, header, rows, lineNumbers);
    }

    public static String stripBom(String s) {
        return !s.isEmpty() && s.charAt(0) == '﻿' ? s.substring(1) : s;
    }

    public static String[] split(String line, char sep) {
        if (line.indexOf('"') < 0) {
            return line.split(String.valueOf(sep), -1);
        }
        List<String> out = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean quoted = false;
        for (int i = 0; i < line.length(); i++) {
            char c = line.charAt(i);
            if (quoted) {
                if (c == '"' && i + 1 < line.length() && line.charAt(i + 1) == '"') {
                    cur.append('"');
                    i++;
                } else if (c == '"') {
                    quoted = false;
                } else {
                    cur.append(c);
                }
            } else if (c == '"') {
                quoted = true;
            } else if (c == sep) {
                out.add(cur.toString());
                cur.setLength(0);
            } else {
                cur.append(c);
            }
        }
        out.add(cur.toString());
        return out.toArray(String[]::new);
    }
}
