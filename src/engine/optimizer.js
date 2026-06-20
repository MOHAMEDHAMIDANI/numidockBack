// H8: Simulated Annealing improvement pass.
// Reuses the constructive engine as a "decoder": given an ordering of trucks,
// it builds a schedule, then we score it. SA searches for the best ordering.

const { generateScheduleFromOrder } = require('./scheduler');

// Score a schedule result. LOWER is better.
// Fj = expected_completion_min − window_start_min  (service done minus arrival time).
// Overtime uses expected_dock_release_min so UNLOAD stocking past horizon is penalised.
function scoreSchedule(result, params) {
  const W_UNSCHEDULED = 100000;
  const W_OVERTIME    = 100;
  const W_FLOW        = 1;

  let totalFlow = 0;
  let overtime  = 0;

  for (const a of result.appointments) {
    totalFlow += a.expected_completion_min - a.window_start_min;
    if (a.expected_dock_release_min > params.horizon_end_min) {
      overtime += a.expected_dock_release_min - params.horizon_end_min;
    }
  }

  return W_UNSCHEDULED * result.unscheduled.length + W_OVERTIME * overtime + W_FLOW * totalFlow;
}

// Fisher-Yates shuffle (returns a new array)
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Neighbour move: swap two random trucks in the ordering
function swapNeighbour(order) {
  const a = [...order];
  if (a.length < 2) return a;
  const i = Math.floor(Math.random() * a.length);
  let j = Math.floor(Math.random() * a.length);
  while (j === i) j = Math.floor(Math.random() * a.length);
  [a[i], a[j]] = [a[j], a[i]];
  return a;
}

function optimize(trucks, params, options = {}) {
  const timeBudgetMs = options.timeBudgetMs || 3000;
  const startTemp = options.startTemp || 1000;
  const coolingRate = options.coolingRate || 0.995;

  // Initial solution = the constructive order (longest-first), evaluated.
  let currentOrder = [...trucks];
  let currentResult = generateScheduleFromOrder(currentOrder, params);
  let currentScore = scoreSchedule(currentResult, params);

  let bestOrder = currentOrder;
  let bestResult = currentResult;
  let bestScore = currentScore;

  let temp = startTemp;
  const start = Date.now();
  let iterations = 0;

  while (Date.now() - start < timeBudgetMs) {
    const neighbour = swapNeighbour(currentOrder);
    const result = generateScheduleFromOrder(neighbour, params);
    const score = scoreSchedule(result, params);

    const delta = score - currentScore;
    // accept if better, or sometimes if worse (probability depends on temp)
    if (delta < 0 || Math.random() < Math.exp(-delta / temp)) {
      currentOrder = neighbour;
      currentResult = result;
      currentScore = score;

      if (score < bestScore) {
        bestOrder = neighbour;
        bestResult = result;
        bestScore = score;
      }
    }

    temp *= coolingRate;
    if (temp < 0.1) temp = startTemp; // reheat
    iterations++;
  }

  return {
    appointments: bestResult.appointments,
    unscheduled: bestResult.unscheduled,
    score: bestScore,
    iterations,
  };
}

module.exports = { optimize, scoreSchedule };