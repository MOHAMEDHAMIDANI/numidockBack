// NumiDock scheduling engine (H3A-style constructive, generates appointment times a_j)
// Pure function: no DB, no HTTP. Input trucks + parameters -> appointments + unscheduled.
//
// Dock occupancy rules per operation type:
//   UNLOAD     : no preparation at dock → busy [serviceStart, serviceStart + service + mise]
//   LOAD       : prep at dock, no mise  → busy [serviceStart - prep, serviceStart + service]
//   LOAD_UNLOAD: both                   → busy [serviceStart - prep, serviceStart + service + mise]

function shiftWorkersAt(minute, shifts) {
  for (const s of shifts) {
    if (minute >= s.start_min && minute < s.end_min) return s.workers_available;
  }
  return 0;
}

// Returns the dock-busy window and key time points for one truck placement.
function dockWindow(op, svcStart, prep, svc, mise) {
  const svcEnd    = svcStart + svc;
  const relEnd    = svcEnd + mise;
  // UNLOAD: service starts directly at dock (no prep phase); LOAD/LOAD_UNLOAD: prep occupies dock first
  const busyStart = op === 'UNLOAD' ? svcStart        : svcStart - prep;
  // LOAD: dock is free once service ends (truck departs, no stocking); others: mise keeps dock busy
  const busyEnd   = op === 'LOAD'   ? svcEnd          : relEnd;
  return { busyStart, busyEnd, svcEnd, relEnd };
}

// Earliest valid serviceStart for a given op (UNLOAD has no prep offset at the horizon boundary).
function minSvcStart(op, horizonStart, prep) {
  return op === 'UNLOAD' ? horizonStart : horizonStart + prep;
}

function generateScheduleFromOrder(ordered, params) {
  const {
    dock_count, horizon_start_min, horizon_end_min, workers_per_dock,
    slot_minutes, arrival_window_min, shifts, durations,
    blocked_docks = 0, dock_turnover_buffer_min = 0,
  } = params;

  const effectiveDocks = Math.max(0, dock_count - blocked_docks);
  const durMap = {};
  for (const d of durations) durMap[d.operation_type] = d;

  const dockBusy    = Array.from({ length: effectiveDocks }, () => []);
  const reservations = [];

  function dockFree(dock, start, end) {
    return dockBusy[dock].every((b) => end <= b.start || start >= b.end);
  }
  function workersOk(start, end) {
    for (let t = start; t < end; t += slot_minutes) {
      const active = reservations.filter((r) => t >= r.start && t < r.end).length + 1;
      const cap = Math.floor(shiftWorkersAt(t, shifts) / workers_per_dock);
      if (active > cap) return false;
    }
    return true;
  }

  const appointments = [];
  const unscheduled  = [];

  for (const truck of ordered) {
    const d    = durMap[truck.operation_type];
    const prep = d.preparation_min;
    const svc  = d.service_min;
    const mise = d.mise_en_stock_min;
    const op   = truck.operation_type;

    let placed = false;

    for (
      let svcStart = minSvcStart(op, horizon_start_min, prep);
      svcStart + svc <= horizon_end_min && !placed;
      svcStart += slot_minutes
    ) {
      const { busyStart, busyEnd, svcEnd, relEnd } = dockWindow(op, svcStart, prep, svc, mise);
      if (busyStart < horizon_start_min) continue;

      for (let dock = 0; dock < effectiveDocks; dock++) {
        if (dockFree(dock, busyStart, busyEnd + dock_turnover_buffer_min) && workersOk(busyStart, svcEnd)) {
          dockBusy[dock].push({ start: busyStart, end: busyEnd + dock_turnover_buffer_min });
          reservations.push({ start: busyStart, end: svcEnd });
          appointments.push({
            truck_request_id: truck.id,
            reference: truck.reference,
            operation_type: op,
            appointment_min: svcStart,
            window_start_min: Math.max(horizon_start_min, svcStart - arrival_window_min),
            window_end_min: svcStart + arrival_window_min,
            dock_number: dock + 1,
            preparation_start_min: busyStart, // svcStart for UNLOAD (no prep), svcStart-prep otherwise
            service_start_min: svcStart,
            expected_completion_min: svcEnd,
            expected_dock_release_min: relEnd,
          });
          placed = true;
          break;
        }
      }
    }
    if (!placed) unscheduled.push({ truck_request_id: truck.id, reference: truck.reference, operation_type: op });
  }

  appointments.sort((a, b) => a.appointment_min - b.appointment_min);
  return { appointments, unscheduled };
}

function generateSchedule(trucks, params) {
  const {
    dock_count, horizon_start_min, horizon_end_min, workers_per_dock,
    slot_minutes, arrival_window_min, shifts, durations,
    blocked_docks = 0, dock_turnover_buffer_min = 0,
  } = params;

  const effectiveDocks = Math.max(0, dock_count - blocked_docks);
  const durMap = {};
  for (const d of durations) durMap[d.operation_type] = d;

  const dockBusy     = Array.from({ length: effectiveDocks }, () => []);
  const reservations = [];

  function dockFree(dock, start, end) {
    return dockBusy[dock].every((b) => end <= b.start || start >= b.end);
  }

  function workersOk(start, end) {
    for (let t = start; t < end; t += slot_minutes) {
      const active = reservations.filter((r) => t >= r.start && t < r.end).length + 1;
      const cap = Math.floor(shiftWorkersAt(t, shifts) / workers_per_dock);
      if (active > cap) return false;
    }
    return true;
  }

  // Sort by actual dock occupation time (longest first — reduces fragmentation).
  function dockOccupation(op) {
    const d = durMap[op];
    if (!d) return 0;
    if (op === 'LOAD')   return d.preparation_min + d.service_min;               // no mise
    if (op === 'UNLOAD') return d.service_min      + d.mise_en_stock_min;         // no prep
    return               d.preparation_min + d.service_min + d.mise_en_stock_min; // LOAD_UNLOAD
  }
  const ordered = [...trucks].sort((a, b) => dockOccupation(b.operation_type) - dockOccupation(a.operation_type));

  const appointments = [];
  const unscheduled  = [];

  for (const truck of ordered) {
    const d    = durMap[truck.operation_type];
    const prep = d.preparation_min;
    const svc  = d.service_min;
    const mise = d.mise_en_stock_min;
    const op   = truck.operation_type;

    let placed = false;

    for (
      let svcStart = minSvcStart(op, horizon_start_min, prep);
      svcStart + svc <= horizon_end_min && !placed;
      svcStart += slot_minutes
    ) {
      const { busyStart, busyEnd, svcEnd, relEnd } = dockWindow(op, svcStart, prep, svc, mise);
      if (busyStart < horizon_start_min) continue;

      for (let dock = 0; dock < effectiveDocks; dock++) {
        if (dockFree(dock, busyStart, busyEnd + dock_turnover_buffer_min) && workersOk(busyStart, svcEnd)) {
          dockBusy[dock].push({ start: busyStart, end: busyEnd + dock_turnover_buffer_min });
          reservations.push({ start: busyStart, end: svcEnd });
          appointments.push({
            truck_request_id: truck.id,
            reference: truck.reference,
            operation_type: op,
            appointment_min: svcStart,
            window_start_min: Math.max(horizon_start_min, svcStart - arrival_window_min),
            window_end_min: svcStart + arrival_window_min,
            dock_number: dock + 1,
            preparation_start_min: busyStart,
            service_start_min: svcStart,
            expected_completion_min: svcEnd,
            expected_dock_release_min: relEnd,
          });
          placed = true;
          break;
        }
      }
    }

    if (!placed) unscheduled.push({ truck_request_id: truck.id, reference: truck.reference, operation_type: op });
  }

  appointments.sort((a, b) => a.appointment_min - b.appointment_min);
  return { appointments, unscheduled };
}

function generateScheduleWithLocks(trucks, lockedAppointments, params) {
  const {
    dock_count, horizon_start_min, horizon_end_min, workers_per_dock,
    slot_minutes, arrival_window_min, shifts, durations,
    blocked_docks = 0, dock_turnover_buffer_min = 0,
  } = params;

  const effectiveDocks = Math.max(0, dock_count - blocked_docks);
  const durMap = {};
  for (const d of durations) durMap[d.operation_type] = d;

  const dockBusy     = Array.from({ length: effectiveDocks }, () => []);
  const reservations = [];
  const lockedIds    = new Set();

  // Pre-populate dock busy from locked appointments using per-type occupancy.
  for (const a of lockedAppointments) {
    const dockIdx = a.dock_number - 1;
    if (dockIdx >= 0 && dockIdx < effectiveDocks) {
      // preparation_start_min is already stored correctly (= svcStart for UNLOAD, svcStart-prep otherwise).
      // Dock end: LOAD frees at service done; UNLOAD/LOAD_UNLOAD hold through mise en stock.
      const lockedBusyEnd = a.operation_type === 'LOAD'
        ? a.expected_completion_min
        : a.expected_dock_release_min;
      dockBusy[dockIdx].push({ start: a.preparation_start_min, end: lockedBusyEnd + dock_turnover_buffer_min });
      reservations.push({ start: a.preparation_start_min, end: a.expected_completion_min });
    }
    lockedIds.add(a.truck_request_id);
  }

  function dockFree(dock, start, end) {
    return dockBusy[dock].every((b) => end <= b.start || start >= b.end);
  }
  function workersOk(start, end) {
    for (let t = start; t < end; t += slot_minutes) {
      const active = reservations.filter((r) => t >= r.start && t < r.end).length + 1;
      const cap = Math.floor(shiftWorkersAt(t, shifts) / workers_per_dock);
      if (active > cap) return false;
    }
    return true;
  }

  const unlockedTrucks = trucks.filter((t) => !lockedIds.has(t.id));
  function dockOccupation(op) {
    const d = durMap[op];
    if (!d) return 0;
    if (op === 'LOAD')   return d.preparation_min + d.service_min;
    if (op === 'UNLOAD') return d.service_min      + d.mise_en_stock_min;
    return               d.preparation_min + d.service_min + d.mise_en_stock_min;
  }
  const ordered = [...unlockedTrucks].sort((a, b) => dockOccupation(b.operation_type) - dockOccupation(a.operation_type));

  const appointments = lockedAppointments.map((a) => ({ ...a }));
  const unscheduled  = [];

  for (const truck of ordered) {
    const d = durMap[truck.operation_type];
    if (!d) {
      unscheduled.push({ truck_request_id: truck.id, reference: truck.reference, operation_type: truck.operation_type });
      continue;
    }
    const prep = d.preparation_min;
    const svc  = d.service_min;
    const mise = d.mise_en_stock_min;
    const op   = truck.operation_type;
    let placed = false;

    for (
      let svcStart = minSvcStart(op, horizon_start_min, prep);
      svcStart + svc <= horizon_end_min && !placed;
      svcStart += slot_minutes
    ) {
      const { busyStart, busyEnd, svcEnd, relEnd } = dockWindow(op, svcStart, prep, svc, mise);
      if (busyStart < horizon_start_min) continue;

      for (let dock = 0; dock < effectiveDocks; dock++) {
        if (dockFree(dock, busyStart, busyEnd + dock_turnover_buffer_min) && workersOk(busyStart, svcEnd)) {
          dockBusy[dock].push({ start: busyStart, end: busyEnd + dock_turnover_buffer_min });
          reservations.push({ start: busyStart, end: svcEnd });
          appointments.push({
            truck_request_id: truck.id,
            reference: truck.reference,
            operation_type: op,
            appointment_min: svcStart,
            window_start_min: Math.max(horizon_start_min, svcStart - arrival_window_min),
            window_end_min: svcStart + arrival_window_min,
            dock_number: dock + 1,
            preparation_start_min: busyStart,
            service_start_min: svcStart,
            expected_completion_min: svcEnd,
            expected_dock_release_min: relEnd,
          });
          placed = true;
          break;
        }
      }
    }
    if (!placed) unscheduled.push({ truck_request_id: truck.id, reference: truck.reference, operation_type: op });
  }

  appointments.sort((a, b) => a.appointment_min - b.appointment_min);
  return { appointments, unscheduled };
}

module.exports = { generateSchedule, generateScheduleFromOrder, generateScheduleWithLocks };
