# Apple Health export.xml format reference

Reference for the native Apple Health export format, gathered for the planned
`apple-xml` format importer. Sources: the DTD embedded in a real export
(HealthKit Export Version 14, generated January 2026 from iOS 26-era devices)
and an element census of that 3.1 GB `export.xml`. Structural examples below
are sanitized; no personal data appears in this document.

## Export package layout

Sharing "Export All Health Data" from the Health app produces `export.zip`
containing:

```text
apple_health_export/
  export.xml           the HealthKit data (everything below)
  export_cda.xml       the same clinical subset as CDA; ignorable for import
  workout-routes/      route_YYYY-MM-DD_H.MMam.gpx files, one per recorded route
  electrocardiograms/  ECG waveform files
  clinical-records/    FHIR JSON files referenced by ClinicalRecord elements
```

`export.xml` for ~10 years of watch data is gigabytes (3.1 GB observed), which
is why the importer plan shreds it once rather than parsing per query.

## Document structure

One root `HealthData` element (with a `locale` attribute), an inline DTD, then:

```text
HealthData
  ExportDate      value="..."
  Me              date of birth, biological sex, blood type, skin type,
                  cardio-fitness medication use (personal data — handle care)
  (Record | Correlation | Workout | ActivitySummary | ClinicalRecord
   | Audiogram | VisionPrescription)*
```

Element counts from the observed export, for scale:

| Element | Count | Notes |
|---|---|---|
| `Record` | 7,377,008 | 93 distinct `type` values |
| `MetadataEntry` | 2,460,266 | children of records, workouts, routes |
| `InstantaneousBeatsPerMinute` | 912,953 | per-beat HRV data, nested in records |
| `HeartRateVariabilityMetadataList` | 19,633 | wraps the per-beat lists |
| `WorkoutStatistics` | 9,464 | ~3-7 per workout |
| `WorkoutEvent` | 3,684 | pause/resume/segment markers |
| `ActivitySummary` | 3,176 | one per day (rings) |
| `Workout` | 2,917 | 16 distinct activity types |
| `WorkoutRoute` / `FileReference` | 584 | pointers into `workout-routes/` |
| `Correlation` | 529 | food (517), blood pressure (12) |
| `ClinicalRecord` | 451 | pointers into `clinical-records/` FHIR files |

## Record

The workhorse element. Attributes: `type` (required), `unit`, `value`,
`sourceName` (required), `sourceVersion`, `device`, `creationDate`,
`startDate` (required), `endDate` (required).

```xml
<Record type="HKQuantityTypeIdentifierHeartRate" sourceName="Apple Watch"
  sourceVersion="10.6.1"
  device="&lt;&lt;HKDevice: 0x...&gt;, name:Apple Watch, manufacturer:Apple Inc., ...&gt;"
  unit="count/min" creationDate="2024-10-25 07:05:11 -0500"
  startDate="2024-10-25 07:04:44 -0500" endDate="2024-10-25 07:04:44 -0500"
  value="71"/>
```

Facts that matter for an importer:

- **Dates are local time with a UTC offset**: `YYYY-MM-DD HH:MM:SS -0500`.
  Truncating the offset (as the CSV loader's `SUBSTR(..., 1, 19)` cast does)
  yields local wall-clock time; keeping it means normalizing to UTC. Whichever
  is chosen must match what the Simple Health Export CSV path produces for the
  same data, or cross-format results diverge.
- **Category values are text labels** in `value` (e.g.
  `HKCategoryValueSleepAnalysisAsleepCore`), exactly as in the CSV format.
- **`device` strings contain commas, angle brackets (escaped), and colons**;
  `sourceName` can contain non-ASCII characters (curly apostrophes in device
  names). CSV emission must quote these.
- **Attribute presence varies by type**: quantity records carry `unit` +
  numeric `value`; category records carry `value` with no `unit`; a few types
  (see below) carry neither. Attribute *order* also varies between records.
- **Records may have children**: `MetadataEntry` key/value pairs, and for HRV
  records a `HeartRateVariabilityMetadataList` of per-beat
  `InstantaneousBeatsPerMinute` readings (bpm + time). A flat shredder that
  drops children loses the per-beat data — acceptable for the importer's first
  pass, but a known loss to document.
- **93 distinct types observed**, dominated by watch telemetry
  (ActiveEnergyBurned 2.4 M, HeartRate 1.1 M, BasalEnergyBurned 1.1 M).
  Includes newer identifiers such as `HKQuantityTypeIdentifierPhysicalEffort`,
  `TimeInDaylight`, `AppleSleepingBreathingDisturbances`, cycling
  power/cadence/speed, and running dynamics.
- **Not every type contains "TypeIdentifier"**: `HKDataTypeSleepDurationGoal`
  is a bare `HKDataType*` name. Detection regexes anchored on
  `TypeIdentifier` (both this repo's CSV regex and ahcd's) skip it silently.

## Workout

**The single most important structural fact:** in modern exports, workout
totals live in `WorkoutStatistics` child elements, not attributes. The
`Workout` element itself carries only `workoutActivityType`, `duration`
(+ unit), source/device, and dates. `totalDistance` / `totalEnergyBurned`
attributes exist in the DTD but are absent on watch-recorded workouts in this
export — including nine-year-old rows. Third-party-sourced workouts (e.g.
Strava) also omit statistics children entirely, carrying only `duration`.

```xml
<Workout workoutActivityType="HKWorkoutActivityTypeWalking"
  duration="14.866..." durationUnit="min" sourceName="Apple Watch" ...
  startDate="2026-01-10 11:12:26 -0500" endDate="2026-01-10 11:27:18 -0500">
  <MetadataEntry key="HKIndoorWorkout" value="0"/>
  <MetadataEntry key="HKElevationAscended" value="418 cm"/>
  <MetadataEntry key="HKTimeZone" value="America/New_York"/>
  <MetadataEntry key="HKAverageMETs" value="4.52156 kcal/hr·kg"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning"
    startDate="..." endDate="..." sum="0.536602" unit="mi"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned"
    startDate="..." endDate="..." sum="56.1244" unit="Cal"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate"
    startDate="..." endDate="..." average="109.484" minimum="100" maximum="117"
    unit="count/min"/>
  <WorkoutRoute sourceName="Apple Watch" ...>
    <FileReference path="/workout-routes/route_2026-01-10_11.27am.gpx"/>
  </WorkoutRoute>
</Workout>
```

- `WorkoutStatistics` carries `sum` for cumulative quantities (distance,
  energy) and `average`/`minimum`/`maximum` for sampled ones (heart rate,
  cadence, power, speed) — 3-7 per workout typically.
- `WorkoutEvent` children mark pauses/resumes (`HKWorkoutEventTypePause`,
  `...Resume`) with their own dates; wall-clock duration from
  `startDate`/`endDate` therefore *includes* paused time, while the `duration`
  attribute excludes it. This repo's derive-duration-from-timestamps invariant
  overstates moving time for paused workouts — same as the CSV format, but
  worth knowing.
- `MetadataEntry` values often embed units in the string (`"418 cm"`,
  `"1800 s"`), and the same key can repeat within one workout.
- The DTD also defines `WorkoutActivity` (multisport sub-activities with
  `uuid`); none appear in this export.
- 16 activity types observed; cycling, walking, strength training, and
  running dominate.

## Correlation

`Correlation` groups records (food nutrition sets, blood pressure
systolic+diastolic pairs). Per the DTD's own comment, **child records of a
correlation also appear as top-level records** — so a shredder that ignores
`Correlation` elements loses only the grouping, never the data. Both observed
correlation types confirm this.

## Other top-level elements

- `ActivitySummary` — one per day: move/exercise/stand values and goals
  (`dateComponents="2026-01-09"`). Not representable in the current per-metric
  table model without a dedicated table; ahcd ignores it today.
- `ClinicalRecord` — pointers (`resourceFilePath`) to FHIR JSON in
  `clinical-records/`; type, FHIR version, received date.
- `Audiogram` — hearing test `SensitivityPoint` children.
- `VisionPrescription` — eye prescription data.

## Implications for the apple-xml importer

1. **Workout CSVs must be assembled from `WorkoutStatistics` children.** A
   parser reading only `Workout` attributes (the current
   `neiltron/ahcd@parse_workouts` behavior) yields workouts with no distance
   and no energy for every watch-recorded workout. Suggested emission: one row
   per workout with pivoted columns (`totalDistance`, `totalEnergyBurned`,
   `avgHeartRate`, ...) derived from the statistics, preserving units.
2. **Schema per type must be a union, not first-element-wins.** Attribute sets
   vary within a type (e.g. `device` present only for on-device records;
   Strava workouts lack statistics). A fixed header frozen from the first
   element drops fields on later rows.
3. **Date normalization needs a decision**: keep the offset (normalize to UTC)
   or truncate to local wall-clock (current CSV-path behavior). Consistency
   with the simple-csv importer wins by default.
4. **Volume**: 7.4 M records / 3.1 GB argues for a streaming parser with
   batched writes (ahcd's SAX approach is right) and for shredding once, not
   per-query.
5. **Out of scope initially, by the data**: per-beat HRV lists, activity
   summaries, correlations (grouping only), clinical/audiogram/vision
   elements, GPX routes, ECGs. Each is a documented loss, not silent.
6. **Detection edge**: `HKDataType*` names (no "TypeIdentifier") exist; the
   canonical-name mapping should decide their fate explicitly rather than
   relying on a regex accident.

## Version notes

The `<!-- HealthKit Export Version: 14 -->` comment identifies the format
generation. The absence of workout total attributes (moved to statistics)
matches HealthKit's iOS 16 deprecation of `HKWorkout.totalDistance`/
`totalEnergyBurned` in favor of `statistics(for:)`. Older exports (pre-iOS 16)
may still carry the attributes; an importer should read attributes when
present and fall back to statistics — or emit both with statistics taking
precedence.
