
/* risk-calculator.js */
window.RiskCalculator = (() => {
  const config = window.RISK_CONFIG;
  const items = ["rainfall", "windSpeed", "waveHeight"];

  function validateConfig() {
    if (!config || !config.weights || !config.scoreThresholds) {
      throw new Error("위험도 설정을 불러오지 못했습니다.");
    }

    const weightSum = items.reduce(
      (sum, key) => sum + config.weights[key], 0
    );

    if (items.some(key =>
      !Number.isFinite(config.weights[key]) ||
      config.weights[key] < 0
    ) || Math.abs(weightSum - 1) > 1e-9) {
      throw new Error("위험도 가중치 설정이 올바르지 않습니다.");
    }

    for (const key of items) {
      const rows = config.scoreThresholds[key];

      if (!Array.isArray(rows) || rows.length === 0 ||
          rows[0][0] !== 0 || rows[rows.length - 1][1] !== 100) {
        throw new Error(`${key} 점수 기준을 확인하세요.`);
      }

      for (let i = 0; i < rows.length; i++) {
        const [value, score] = rows[i];

        if (!Number.isFinite(value) ||
            !Number.isInteger(score) ||
            score < 0 || score > 100 ||
            (i > 0 &&
              (value <= rows[i - 1][0] ||
               score < rows[i - 1][1]))) {
          throw new Error(`${key} 점수 구간이 올바르지 않습니다.`);
        }
      }
    }
  }

  function itemScore(key, value) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`${key} 측정값이 유효하지 않습니다.`);
    }

    let score = 0;

    for (const [minimum, points] of config.scoreThresholds[key]) {
      if (value < minimum) break;
      score = points;
    }

    return Math.max(0, Math.min(100, score));
  }

  function gradeFor(score) {
    let grade = null;

    for (const [minimum, label] of config.grades) {
      if (score < minimum) break;
      grade = label;
    }

    return grade;
  }

  function inspect(value, observedAt, now) {
    if (value === null || value === undefined || value === "") {
      return "missing";
    }

    if (typeof value !== "number" ||
        !Number.isFinite(value) || value < 0) {
      return "invalid";
    }

    if (typeof observedAt !== "string" || !observedAt.trim()) {
      return "unknown_time";
    }

    const time = Date.parse(observedAt);

    if (!Number.isFinite(time)) return "unknown_time";

    const age = now.getTime() - time;

    if (age < 0) return "invalid_time";
    if (age > config.maxAgeMinutes * 60_000) return "stale";

    return "ok";
  }

  function calculate(weather, now = new Date()) {
    validateConfig();

    const rain = weather?.rain;
    const wind = weather?.marine?.wind;
    const wave = weather?.marine?.wave;

    const inputs = {
      rainfall: rain,
      windSpeed: wind,
      waveHeight: wave,
    };

    const statuses = {};

    for (const key of items) {
      const entry = inputs[key];

      statuses[key] = inspect(
        entry?.value,
        entry?.observedAt,
        now
      );

      // API에서 제공한 모델값과 관측값을 구분
      if (statuses[key] === "ok" && entry?.modelled === true) {
        statuses[key] = "modelled";
      }
    }

    const unavailable = items.some(key =>
      statuses[key] !== "ok" && statuses[key] !== "modelled"
    );

    // 모델값은 출처를 구분해서 표시하되, API가 실제로 제공한 값일 때만 사용
    if (unavailable) {
      return {
        available: false,
        totalScore: null,
        grade: "산정 불가",
        itemScores: null,
        statuses,
        observedAt: Object.fromEntries(
          items.map(key => [key, inputs[key]?.observedAt ?? null])
        ),
        notice: config.safetyNotice,
        criteriaNotice: config.criteriaNotice,
      };
    }

    const itemScores = {
      rainfall: itemScore("rainfall", rain.value),
      windSpeed: itemScore("windSpeed", wind.value),
      waveHeight: itemScore("waveHeight", wave.value),
    };

    const weighted =
      itemScores.rainfall * config.weights.rainfall +
      itemScores.windSpeed * config.weights.windSpeed +
      itemScores.waveHeight * config.weights.waveHeight;

    const totalScore = Math.max(
      0, Math.min(100, Math.round(weighted))
    );

    return {
      available: true,
      totalScore,
      grade: gradeFor(totalScore),
      itemScores,
      statuses,
      observedAt: Object.fromEntries(
        items.map(key => [key, inputs[key].observedAt])
      ),
      weights: config.weights,
      notice: config.safetyNotice,
      criteriaNotice: config.criteriaNotice,
    };
  }

  return { calculate, itemScore, gradeFor, validateConfig };
})();