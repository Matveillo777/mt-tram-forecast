package ru.tramforecast.live;

import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.SplittableRandom;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import ru.tramforecast.data.DataStore;
import ru.tramforecast.data.DataStore.Grid;

import static ru.tramforecast.data.DataStore.HOURS;

/**
 * Демо-поток валидаций для экрана "Онлайн": ускоренные сутки живой даты, число проходов
 * по Пуассону вокруг p50 прогноза. Записи идут через тот же IngestService, что и POST /ingest.
 * Когда сутки заканчиваются, счетчики даты обнуляются и день проигрывается заново.
 */
@Component
public class DemoStream {

    private static final Logger log = LoggerFactory.getLogger(DemoStream.class);
    private static final int DAY_MINUTES = HOURS * 60;
    private static final double REJECT_SHARE = 0.03;

    private final IngestService ingest;
    private final DataStore store;
    private final boolean enabled;
    private final LocalDate date;
    private final double minutesPerTick;
    private final SplittableRandom random = new SplittableRandom(42);
    private volatile double clock;

    public DemoStream(IngestService ingest, DataStore store,
                      @Value("${app.live.date:}") String liveDate,
                      @Value("${app.live.demo:true}") boolean enabled,
                      @Value("${app.live.seconds-per-hour:20}") double secondsPerHour,
                      @Value("${app.live.demo-start-hour:6}") int startHour) {
        this.ingest = ingest;
        this.store = store;
        try {
            this.date = liveDate == null || liveDate.isBlank() ? store.today() : LocalDate.parse(liveDate.trim());
        } catch (DateTimeParseException e) {
            throw new IllegalStateException("app.live.date (LIVE_DATE) должен быть датой ГГГГ-ММ-ДД, указано '"
                    + liveDate + "'");
        }
        this.enabled = enabled && store.forecast().contains(date);
        this.minutesPerTick = 60.0 / secondsPerHour;
        if (enabled && !this.enabled) {
            log.warn("Демо-поток выключен: живая дата {} вне периода прогноза", date);
        }
        if (this.enabled) {
            // сразу заполняем ночь и раннее утро, чтобы экран не начинался с пустого графика
            clock = Math.max(0, Math.min(startHour, HOURS - 1)) * 60;
            ingest.reset(date);
            generate(0, clock);
            log.info("Демо-поток валидаций включен: дата {}, 1 час суток = {} с", date, secondsPerHour);
        }
    }

    public boolean enabled() {
        return enabled;
    }

    /** Живая дата экрана "Онлайн": app.live.date или сегодня. */
    public LocalDate date() {
        return date;
    }

    /** Модельное время суток в демо-потоке, ЧЧ:ММ. */
    public String simTime() {
        int m = (int) clock;
        return String.format("%02d:%02d", m / 60, m % 60);
    }

    @Scheduled(fixedRate = 1000, initialDelay = 1000)
    void tick() {
        if (!enabled) {
            return;
        }
        double from = clock;
        if (from == 0) {
            ingest.reset(date);
        }
        double to = Math.min(from + minutesPerTick, DAY_MINUTES);
        generate(from, to);
        clock = to >= DAY_MINUTES ? 0 : to;
    }

    private void generate(double fromMin, double toMin) {
        Grid g = store.forecast();
        int day = g.day(date);
        IngestService.Batch batch = ingest.batch();
        String prefix = date + " ";
        for (int r = 0; r < store.routes().length; r++) {
            String route = store.routes()[r].route() + " трамвай";
            for (int h = (int) (fromMin / 60); h < HOURS && h * 60 < toMin; h++) {
                double lo = Math.max(fromMin, h * 60);
                double hi = Math.min(toMin, (h + 1) * 60);
                double expected = g.cols()[1][g.index(r, day, h)] * (hi - lo) / 60;
                int n = poisson(expected);
                int rejects = poisson(expected * REJECT_SHARE);
                for (int i = 0; i < n + rejects; i++) {
                    int second = (int) ((lo + random.nextDouble() * (hi - lo)) * 60);
                    String time = prefix + two(second / 3600) + ":" + two(second / 60 % 60) + ":" + two(second % 60);
                    batch.add("демо, запись ", i, route, i < n ? "1" : "0", time);
                }
            }
        }
        batch.commit();
    }

    private int poisson(double lambda) {
        if (lambda <= 0) {
            return 0;
        }
        if (lambda > 30) {
            // нормальное приближение, для больших потоков точности хватает
            double v = lambda + Math.sqrt(lambda) * gaussian();
            return (int) Math.max(0, Math.round(v));
        }
        double limit = Math.exp(-lambda);
        double p = random.nextDouble();
        int k = 0;
        while (p > limit) {
            p *= random.nextDouble();
            k++;
        }
        return k;
    }

    private double gaussian() {
        double u = 1 - random.nextDouble();
        double v = random.nextDouble();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    private static String two(int v) {
        return v < 10 ? "0" + v : Integer.toString(v);
    }
}
