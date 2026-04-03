/**
 * Re-export all UI modules from a single entry point
 * so that main.ts imports remain unchanged.
 */
export { renderDashboard, renderHeader } from './print-status';
export { renderCanvas } from './canvas';
export { renderFiles } from './files';
export { bindControls } from './controls';
export { registerChart, initCharts } from './charts';
export { renderStructuredLog, bindStructuredLogControls } from './structured-log';

