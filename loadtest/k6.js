// Mixed load: forecasts for all horizons, map, stop filter with corrections, export and streaming ingest.
// Run: k6 run -e BASE=http://localhost:8081 -e RATE=400 -e DURATION=60s loadtest/k6.js
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE || 'http://localhost:8081';
const RATE = Number(__ENV.RATE || 400);
const DURATION = __ENV.DURATION || '60s';
const ROUTES = [1, 7, 11, 12, 17, 25, 26, 28, 50];

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 200,
      maxVUs: 1000,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p(95)<300'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const day = () => `2025-11-${String(1 + Math.floor(Math.random() * 28)).padStart(2, '0')}`;

function ingestBody() {
  const header = 'tran_no;device_no;tran_date_time;begin_date_time;input_date_time;crd_hashcode;validation_result;tran_type_id;place_id;good_type;pass_route;ngpt_route;bus_exit_no;garage_number';
  const rows = [header];
  for (let i = 0; i < 100; i++) {
    const h = String(Math.floor(Math.random() * 24)).padStart(2, '0');
    const ts = `2025-11-01 ${h}:${String(i % 60).padStart(2, '0')}:00`;
    rows.push(`${i};1;${ts};${ts};${ts};card${i};1;52;39707;30 дней;НГПТ;${pick(ROUTES)} трамвай;201;31000`);
  }
  return rows.join('\n');
}

export function setup() {
  const res = http.get(`${BASE}/api/v1/routes/17`);
  const stops = res.status === 200 ? res.json('stops').map((s) => s.stop_id) : [];
  return { stops };
}

export default function (data) {
  const r = Math.random();
  let res;
  if (r < 0.35) {
    res = http.get(`${BASE}/api/v1/forecast?horizon=day&route=${pick(ROUTES)}`, { tags: { name: 'forecast_day' } });
  } else if (r < 0.55) {
    res = http.get(`${BASE}/api/v1/forecast?horizon=month&route=${pick(ROUTES)}&granularity=day`, { tags: { name: 'forecast_month' } });
  } else if (r < 0.65) {
    res = http.get(`${BASE}/api/v1/forecast?horizon=year&granularity=month`, { tags: { name: 'forecast_year' } });
  } else if (r < 0.75) {
    res = http.get(`${BASE}/api/v1/map?date=${day()}&hour=${Math.floor(Math.random() * 24)}`, { tags: { name: 'map' } });
  } else if (r < 0.85 && data.stops.length) {
    res = http.get(`${BASE}/api/v1/forecast?horizon=month&route=17&stop=${pick(data.stops)}&hourFrom=7&hourTo=10&snowCm=5&tempDelta=-5`, { tags: { name: 'forecast_stop_corr' } });
  } else if (r < 0.9) {
    res = http.get(`${BASE}/api/v1/export?format=csv&horizon=day&route=${pick(ROUTES)}`, { tags: { name: 'export_csv' } });
  } else {
    res = http.post(`${BASE}/api/v1/ingest/validations`, ingestBody(), { headers: { 'Content-Type': 'text/csv' }, tags: { name: 'ingest_100' } });
  }
  check(res, { 'status 200': (x) => x.status === 200 });
}
