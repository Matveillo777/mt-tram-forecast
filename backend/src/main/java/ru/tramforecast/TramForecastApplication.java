package ru.tramforecast;

import java.util.List;

import io.swagger.v3.oas.annotations.OpenAPIDefinition;
import io.swagger.v3.oas.annotations.info.Info;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.context.annotation.Bean;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.reactive.CorsWebFilter;
import org.springframework.web.cors.reactive.UrlBasedCorsConfigurationSource;

@SpringBootApplication
@EnableScheduling
@OpenAPIDefinition(info = @Info(title = "Прогноз загрузки трамвайных маршрутов", version = "1.0",
        description = "Прогноз посадок по маршрутам, остановкам и часам на день, месяц и год; "
                + "сценарии с поправками, выгрузка, расчет выпуска, прием валидаций"))
public class TramForecastApplication {

    public static void main(String[] args) {
        SpringApplication.run(TramForecastApplication.class, args);
    }

    /** Чтение API открыто для любых сайтов, запись (POST /ingest) - только с того же адреса. */
    @Bean
    CorsWebFilter corsFilter(@Value("${app.cors.allowed-origins:*}") List<String> origins) {
        CorsConfiguration cors = new CorsConfiguration();
        cors.setAllowedOrigins(origins);
        cors.setAllowedMethods(List.of("GET", "HEAD"));
        cors.addAllowedHeader("*");
        cors.addExposedHeader("Content-Disposition");
        cors.setMaxAge(3600L);
        UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
        source.registerCorsConfiguration("/**", cors);
        return new CorsWebFilter(source);
    }
}
