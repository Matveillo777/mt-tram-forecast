# Прогноз загрузки трамвайных маршрутов Москвы

Хакатон Московского транспорта, задача «ИИ-прогноз загрузки трамвайных маршрутов».

Сервис прогнозирует посадки на 10 трамвайных маршрутах по часам на три горизонта (день, месяц, год), раскладывает прогноз по остановкам, показывает динамику на карте Москвы, пересчитывает прогноз при изменении погоды и событий, подсказывает диспетчеру, сколько рейсов нужно в каждый час, и отдаёт всё через REST API и выгрузку в CSV и XLSX.

## Запуск для жюри

Нужен Docker с Docker Compose.

```bash
git clone https://github.com/Matveillo777/mt-tram-forecast.git
cd mt-tram-forecast
docker compose up --build
```

Первая сборка занимает несколько минут. После запуска:

| Что | Адрес |
|---|---|
| Интерфейс | http://localhost:8080 |
| API | http://localhost:8081/api/v1/meta |
| Описание API (OpenAPI) | TBD_OPENAPI |
| Проверка здоровья | http://localhost:8081/actuator/health |

TBD_DEMO

Данные организаторов для запуска сервиса не нужны: готовый прогноз и почасовая история лежат в `ml/artifacts/`. Они нужны только чтобы пересчитать всё с нуля (раздел «ML-контур» ниже).

## Что умеет

| Требование | Где |
|---|---|
| Прогноз на день по часам, на месяц, на год | `GET /api/v1/forecast?horizon=day|month|year`, страница «Прогноз» |
| Агрегация по маршруту, остановке, интервалу дат и часов | параметры `route`, `stop`, `from`, `to`, `hourFrom`, `hourTo`, `granularity` |
| Карта Москвы с динамикой по часам и остановкам | страница «Карта», `GET /api/v1/map` |
| Выгрузка CSV и XLSX | `GET /api/v1/export?format=csv|xlsx`, кнопки на странице «Прогноз» |
| Внешние факторы: время суток, день недели, праздники, каникулы, погода, ремонты | модель, [docs/external-data.md](docs/external-data.md) |
| Корректирующие коэффициенты с мгновенным пересчётом | страница «Сценарии», параметры `tempDelta`, `precipMm`, `snowCm`, `eventPct`, `seasonPct` |
| Приём потока валидаций | `POST /api/v1/ingest/validations`, страница «Онлайн» |
| Рекомендации по выпуску вагонов | страница «Выпуск», `GET /api/v1/dispatch` |

## Точки входа API

Все ответы в JSON, ошибки в формате `application/problem+json` с понятным текстом на русском.

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/api/v1/meta` | даты истории и прогноза, список маршрутов, горизонты |
| GET | `/api/v1/routes`, `/api/v1/routes/{route}`, `/api/v1/routes/geojson` | маршруты, трассы, остановки |
| GET | `/api/v1/forecast` | прогноз p10 / p50 / p90 с поправками |
| GET | `/api/v1/history` | фактические посадки за январь-октябрь 2025 |
| GET | `/api/v1/map` | значения по маршрутам и остановкам на дату и час |
| GET | `/api/v1/export` | CSV или XLSX с теми же параметрами, что у `/forecast` |
| GET | `/api/v1/dispatch` | рейсы в час, интервал и риск переполнения |
| POST | `/api/v1/ingest/validations` | приём валидаций (CSV в формате датасета или JSON) |
| GET | `/api/v1/live`, `/api/v1/live/stream` | факт потока против прогноза, поток SSE |
| GET | `/api/v1/model`, `/api/v1/factors`, `/api/v1/calendar`, `/api/v1/events` | качество модели, коэффициенты, календарь, события |

Примеры:

```bash
curl "http://localhost:8081/api/v1/forecast?horizon=day&route=17"
curl "http://localhost:8081/api/v1/forecast?horizon=month&route=17&stop=<stop_id>&hourFrom=7&hourTo=10&granularity=day"
curl "http://localhost:8081/api/v1/forecast?horizon=year&granularity=month&snowCm=10&tempDelta=-5"
curl -o forecast.xlsx "http://localhost:8081/api/v1/export?format=xlsx&horizon=month&route=17"
```

## Производительность

TBD_PERF

Методика и полные результаты: [docs/performance.md](docs/performance.md).

## ML-контур

Модель: уровень дня по маршруту x профиль часа. Уровень берётся из последних чистых недель, поправки на праздники, каникулы, погоду и ремонты даёт гребневая регрессия с ограничением знаков, профиль часа средний за 4 недели. Подробно: [docs/model.md](docs/model.md).

TBD_QUALITY

Пересчитать всё с нуля из архива организаторов:

```bash
# положить dataset.zip в ml/data/raw/ или скрипт скачает его с Яндекс Диска сам
docker compose --profile pipeline run --rm pipeline
```

Или без Docker (Python 3.12+):

```bash
cd ml
pip install -r requirements.txt
python -m pipeline.ingest     # сырые валидации -> почасовая история, сверка с разметкой организаторов
python -m pipeline.geo        # трассы, остановки, распределение посадок по остановкам
python -m pipeline.backtest   # проверка на истории и вклад внешних источников
python -m pipeline.forecast   # прогноз на год, коэффициенты, submission/submission.csv
```

Файл для платформы: [submission/submission.csv](submission/submission.csv).

## Документация

- [Архитектура и модули](docs/architecture.md)
- [Модель, область определения и адаптации](docs/model.md)
- [Приём данных и геопривязка](docs/data-pipeline.md)
- [Внешние данные и их эффект](docs/external-data.md)
- [Производительность](docs/performance.md)
- [Ограничения и план развития](docs/limitations-roadmap.md)

## Структура

```
ml/pipeline/      приём данных, геопривязка, внешние факторы, модель, проверка, прогноз
ml/artifacts/     готовые результаты: история, прогноз, маршруты, коэффициенты, метрики
ml/data/external/ внешние данные с источниками
backend/          Java 21, Spring Boot 4.1, WebFlux
frontend/         React 19, TypeScript, MapLibre, ECharts
loadtest/         сценарий нагрузочного теста k6
submission/       файл прогноза для платформы
docs/             документация
```
