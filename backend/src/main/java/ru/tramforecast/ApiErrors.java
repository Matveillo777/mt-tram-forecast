package ru.tramforecast;

import java.util.LinkedHashMap;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.http.MediaType;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.server.reactive.ServerHttpResponse;
import org.springframework.web.ErrorResponse;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.UnsupportedMediaTypeStatusException;
import org.springframework.web.server.WebExceptionHandler;
import reactor.core.publisher.Mono;
import tools.jackson.databind.json.JsonMapper;

/**
 * Все ошибки API отдаются как application/problem+json с понятным русским текстом.
 * Ошибки из контроллеров ловит advice, остальные (неизвестный адрес, чужой метод) - handle()
 * раньше стандартного обработчика Spring Boot, у которого order -1.
 */
@RestControllerAdvice
@Order(-2)
public class ApiErrors implements WebExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiErrors.class);

    private final JsonMapper json;

    public ApiErrors(JsonMapper json) {
        this.json = json;
    }

    @Override
    public Mono<Void> handle(ServerWebExchange exchange, Throwable ex) {
        ServerHttpResponse response = exchange.getResponse();
        if (!(ex instanceof Exception e) || response.isCommitted()) {
            return Mono.error(ex);
        }
        ResponseEntity<ProblemDetail> problem = e instanceof ApiException api ? api(api) : other(e);
        ProblemDetail p = problem.getBody();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", p.getType().toString());
        body.put("title", p.getTitle());
        body.put("status", p.getStatus());
        body.put("detail", p.getDetail());
        body.put("instance", exchange.getRequest().getPath().value());
        response.setStatusCode(problem.getStatusCode());
        response.getHeaders().setContentType(MediaType.APPLICATION_PROBLEM_JSON);
        return response.writeWith(Mono.fromSupplier(() -> response.bufferFactory().wrap(json.writeValueAsBytes(body))));
    }

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ProblemDetail> api(ApiException e) {
        return problem(e.status(), e.getMessage());
    }

    @ExceptionHandler(UnsupportedMediaTypeStatusException.class)
    public ResponseEntity<ProblemDetail> mediaType(UnsupportedMediaTypeStatusException e) {
        return problem(HttpStatus.UNSUPPORTED_MEDIA_TYPE, (e.getContentType() == null
                ? "Заголовок Content-Type не распознан" : "Неподдерживаемый Content-Type: " + e.getContentType())
                + ". Ожидается text/csv или application/json");
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<ProblemDetail> other(Exception e) {
        if (causedBy(e, DataBufferLimitException.class)) {
            return problem(HttpStatus.CONTENT_TOO_LARGE, "Тело запроса больше 10 МБ. Разбейте файл на части");
        }
        if (e instanceof ErrorResponse er) {
            HttpStatusCode status = er.getStatusCode();
            return problem(status, switch (status.value()) {
                case 400 -> "Некорректный запрос: " + er.getBody().getDetail();
                case 404 -> "Такого адреса нет. Список методов API: /swagger-ui.html";
                case 405 -> "Метод не поддерживается для этого адреса";
                case 406 -> "Запрошенный формат ответа не поддерживается";
                // Spring отбрасывает такие запросы раньше контроллера и без пояснения
                case 415 -> "Неподдерживаемый Content-Type. Ожидается text/csv или application/json";
                default -> er.getBody().getDetail() != null ? er.getBody().getDetail()
                        : HttpStatus.valueOf(status.value()).getReasonPhrase();
            });
        }
        log.error("Необработанная ошибка", e);
        return problem(HttpStatus.INTERNAL_SERVER_ERROR, "Внутренняя ошибка сервера. Подробности в журнале сервиса");
    }

    private static boolean causedBy(Throwable e, Class<? extends Throwable> type) {
        for (Throwable t = e; t != null; t = t.getCause()) {
            if (type.isInstance(t)) {
                return true;
            }
        }
        return false;
    }

    private static ResponseEntity<ProblemDetail> problem(HttpStatusCode status, String detail) {
        ProblemDetail body = ProblemDetail.forStatusAndDetail(status, detail);
        body.setTitle(switch (status.value()) {
            case 400 -> "Некорректные параметры запроса";
            case 404 -> "Не найдено";
            case 405 -> "Метод не поддерживается";
            case 406 -> "Формат ответа не поддерживается";
            case 413 -> "Слишком большой запрос";
            case 415 -> "Неподдерживаемый формат данных";
            case 500 -> "Ошибка сервера";
            default -> HttpStatus.valueOf(status.value()).getReasonPhrase();
        });
        return ResponseEntity.status(status).contentType(MediaType.APPLICATION_PROBLEM_JSON).body(body);
    }
}
