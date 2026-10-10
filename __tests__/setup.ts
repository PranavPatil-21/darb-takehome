// Deterministic timezone so date-proximity assertions do not drift with the runner's TZ.
process.env.TZ = 'UTC';
