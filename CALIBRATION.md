# Калибровка DID для метрик, которых нет в car_vitals

Каждая метрика имеет список кандидатов DID; `DidReader` пробует по порядку, первый правдоподобный
выигрывает. Причина отказа видна в логе машины: `DID <metric>: NRC 31 out of range / no reply / ...`.

## Как диагностировать

```powershell
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -i "C:\Users\dmpol\Downloads\MGU-SSH\data\enrollments\WBA6K71050FJ55634\id_rsa" root@169.254.102.111 "grep -E 'DID |raw' /var/opt/public/oap/oap_12450/data/vmgauge.log | tail -60"
```

## Метрики и что пробовать

### Уже исправлены (взято из car_vitals — проверенные)
| Метрика | Кандидаты |
|---|---|
| boost | F470 / F487 / F40B / obd 0B |
| baro | F433 / obd 33 |
| fuelPresAct (рампа, факт) | F423 / F459 / obd 23 |
| ignAdv (угол опережения) | obd 0E / F40E |
| loadDirect (нагрузка %) | 5813 |
| gearbox (t° КПП) | 6000 / DA12 (ecu 24) |
| misfire | OBD service 06 (MID A2.., tid 0C) |

### Есть стандартный OBD-PID — должен работать, проверить лог
| Метрика | Наш кандидат | Стандарт OBD |
|---|---|---|
| lambda | obd 24 | PID 0x24 = эквив. соотношение (raw/32768) — должен работать |
| voltage | obd 42 | PID 0x42 = напряжение модуля (raw/1000) — должен работать |

Если `obd 24`/`obd 42` дают `NRC 31` — DME отказывает OBD-запросу, тогда искать BMW-DID.

### Только BMW-DID (нет в car_vitals) — калибровать по логу
| Метрика | Наш DID | Замечание |
|---|---|---|
| oil pressure | 586F (OELDRUCK) / 4436 | нет стандартного OBD-PID; возможно недоступно на B58 |
| mixture adaptation | 4A9D (KORR_MULT_GEMISCHADAP) | проверить по raw |
| knock retard | 554C (MITTELW_ZYLIND_ZWSPAET_KR) | проверить по raw |
| EGT | 5896 (TEMP_NACH_KAT) / 582F / 579B | проверить по raw |
| fuel temp | 449D / 5639 | проверить по raw |
| thermostat | 5893 / 447F | проверить по raw |
| fan rpm | 5873 / 4457 | проверить по raw |
| radiator temp | 5815 / 4431 | проверить по raw |
| battery current | 5854 (IBS_STROM) | проверить по raw |
| alternator current | 4469 / 589C | проверить по raw |
| alternator temp | 58A1 | проверить по raw |
| tcase clutch % | 58F0 / 58F1 | car_vitals вместо этого читает момент на переднюю ось `DB32` (xdrive.front) |

## Стратегия

1. Сначала посмотреть лог — у каждой упавшей метрики будет `DID <metric>: <причина>`.
2. `NRC 31 out of range` = DME не знает этот DID → менять DID.
3. `no reply` = DID есть, но не отвечает (другой ECU/сессия) → менять ECU или DID.
4. Стандартные OBD-PID (lambda 0x24, voltage 0x42) если падают с NRC 31 — DME закрыт для OBD, тогда
   подбирать BMW-DID из SGBD (DME8FF_R).
5. Для tcase — рассмотреть переход на `xdrive.front` (DB32, момент на переднюю ось) как у car_vitals.

## v0.1.4: ярусы опроса и новый MAIN

MAIN перекомпонован в сетку 3×4 (данные в плитках центрированы):
- Ряд 1: Boost, AFR, Oil press [FAST ~90 мс] + Knock events [SLOW 8 с]
- Ряд 2: Intake temp, EGT [MED 1.5 с], Gearbox oil [MED], Misfires [SLOW, свип 4 цилиндров ~2 с]
- Ряд 3: Coolant, Oil temp (SOME/IP), Voltage [MED], Rail pressure [FAST]

Пропуски зажигания: OBD service 06, mids A2..A5 (цилиндры 1-4), tid 0x0C; считаются,
как и детонация, только при наддуве > 0.5 бар (первый ответ — базовая точка).

Опрос — конвейер до 5 параллельных UDS-чтений (kit/diag сериализует physical() в один
канал, kit/dids ограничивает maxConcurrent). Пропускная способность канала = 1000/RTT:
при RTT 40 мс это ~25 зап/с, быстрые плитки MAIN получают ~4 обн/с каждая (тест
`node kit/tools/test_vmgauge_poll.js`, RTT задаётся переменной окружения RTT).
При реальном RTT с ГУ (~150 мс по логам) ожидайте ~1 обн/с на быструю плитку — для
проверки замерьте время ответа DID в vmgauge.log и подберите MED_GAP/SLOW_GAP под канал.

## v0.1.5 — Power tab
- Peak reset (hp/Nm) uses the `peakResetSec` setting (seconds, default 6; old `peakResetMs`
  saves are ignored, the new key has a fresh default). The old code read `peakResetMs` which
  existed in app.json but the ttl compared Date.now()-peakAt — reset only fired while computePower
  ran (engine on); peaks now clear 6 s after the last new maximum as intended.
- Bottom chart: fixed y-scale 0..600 (step 100) for both hp and Nm series; chart width
  compressed to ~2/3 of the page and centered horizontally.
