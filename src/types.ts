/** CC2 printer protocol types */

export interface PrinterAttributes {
  hostname: string;
  machine_model: string;
  sn: string;
  ip: string;
  protocol_version: string;
  hardware_version: string;
  software_version: {
    ota_version: string;
    mcu_version: string;
    soc_version: string;
  };
}

export interface MachineStatus {
  status: number;
  sub_status: number;
  sub_status_reason_code?: number;
  exception_status: number[];
  progress: number;
}

export interface PrintStatus {
  filename: string;
  uuid: string;
  current_layer: number;
  total_layer?: number;
  print_duration: number;
  total_duration: number;
  remaining_time_sec: number;
  progress?: number;
  state?: string;
  enable?: boolean;
  bed_mesh_detect?: boolean;
  filament_detect?: boolean;
}

export interface Extruder {
  temperature: number;
  target: number;
  filament_detect_enable: number;
  filament_detected: number;
}

export interface HeaterBed {
  temperature: number;
  target: number;
}

export interface ChamberSensor {
  temperature: number;
  measured_max_temperature: number;
  measured_min_temperature: number;
}

export interface FanInfo {
  speed: number;
  rpm?: number;
}

export interface Fans {
  fan: FanInfo;
  aux_fan: FanInfo;
  box_fan: FanInfo;
  heater_fan: FanInfo;
  controller_fan: FanInfo;
}

export interface GcodeMove {
  x: number;
  y: number;
  z: number;
  e?: number;
  extruder?: number;
  speed: number;
  speed_mode: number;
}

export interface Led {
  status: number;
}

export interface ExternalDevice {
  camera: boolean;
  u_disk: boolean;
  type: string;
}

export interface CanvasTray {
  tray_id: number;
  brand: string;
  filament_type: string;
  filament_name: string;
  filament_color: string;
  min_nozzle_temp: number;
  max_nozzle_temp: number;
  status: number; // 0=empty, 1=loaded, 2=active
}

export interface CanvasUnit {
  canvas_id: number;
  connected: number;
  tray_list: CanvasTray[];
}

export interface CanvasInfo {
  active_canvas_id: number;
  active_tray_id: number;
  auto_refill: boolean;
  canvas_list: CanvasUnit[];
}

export interface PrinterStatus {
  machine_status: MachineStatus;
  print_status: PrintStatus;
  extruder: Extruder;
  heater_bed: HeaterBed;
  ztemperature_sensor: ChamberSensor;
  fans: Fans;
  gcode_move: GcodeMove;
  led: Led;
  tool_head: { homed_axes: string };
  external_device: ExternalDevice;
}

export interface FileEntry {
  name: string;
  size: number;
  modified?: number;
  type?: string;
}

// Machine status codes
export const STATUS_NAMES: Record<number, string> = {
  0: 'Initializing',
  1: 'Idle',
  2: 'Printing',
  3: 'Loading Filament',
  4: 'Loading Filament',
  5: 'Auto Leveling',
  6: 'PID Calibrating',
  7: 'Resonance Testing',
  8: 'Self Checking',
  9: 'Updating',
  10: 'Homing',
  11: 'File Transferring',
  12: 'Creating Timelapse',
  13: 'Extruder Operating',
  14: 'Emergency Stop',
  15: 'Power Loss Recovery',
};

export const SUB_STATUS_NAMES: Record<number, string> = {
  0: '',
  1045: 'Preheating Nozzle',
  1096: 'Preheating Nozzle',
  1405: 'Preheating Bed',
  1906: 'Preheating Bed',
  2075: 'Printing',
  2077: 'Completed',
  2401: 'Resuming',
  2402: 'Resume Complete',
  2501: 'Pausing',
  2502: 'Paused',
  2505: 'Paused',
  2503: 'Stopping',
  2504: 'Stopped',
  2801: 'Homing',
  2802: 'Homing Done',
  2901: 'Auto Leveling',
  2902: 'Leveling Done',
};

export const SPEED_MODE_NAMES: Record<number, string> = {
  0: 'Silent',
  1: 'Balanced',
  2: 'Sport',
  3: 'Ludicrous',
};

// Exception codes from the CC2 protocol
export const EXCEPTION_NAMES: Record<number, string> = {
  101: 'Bed Heat Failed',
  102: 'Bed Temp Sensor Disconnected',
  103: 'Nozzle Heat Failed',
  104: 'Nozzle Temp Sensor Disconnected',
  105: 'Nozzle Temp Sensor Shorted',
  106: 'Bed Temp Sensor Shorted',
  107: 'Toolhead Overheating Protection',
  108: 'Bed Overheating Protection',
  109: 'Filament Runout',
  205: 'Chamber Temp Sensor Disconnected',
  206: 'Chamber Temp Sensor Shorted',
  304: 'Z Homing Failed',
  401: 'Accelerometer Chip Error',
  605: 'Pressure Sensor Data Error',
  701: 'Mainboard Fan Error',
  702: 'Heatbreak Fan Error',
  703: 'Model Fan Error',
  704: 'Leveling Failed',
  705: 'Auxiliary Fan Error',
  706: 'Case Fan Error',
  707: 'Toolhead Front Cover Detached',
  801: 'Mainboard-Extruder Communication Error',
  802: 'Leveling Sensor Controller Communication Error',
  803: 'Critical System Error',
  901: 'Chamber Temp Too High',
  902: 'Chamber Temp Overheating Protection',
  903: 'Mainboard Driver Unit Overheating Protection',
  904: 'USB Storage Space Not Enough',
  905: 'USB Read Exception',
  906: 'Version Update Failed',
  1101: 'Exhaust Vent Open Failed',
  1102: 'Exhaust Vent Close Failed',
  1103: 'X Motor Driver Error',
  1104: 'Y Motor Driver Error',
  1105: 'Z Motor Driver Error',
  1106: 'Extruder Motor Driver Error',
  1210: 'Canvas Communication Error',
  1211: 'Canvas Filament Runout',
  1220: 'Extruder Error',
  1231: 'Filament Cut Failed',
  1232: 'Cutter Handle Not Released',
  1241: 'Loading Error',
  1242: 'Unload Filament At Toolhead Failed',
  1243: 'Toolhead Extrusion Failed',
  1244: 'Toolhead Extrusion Failed',
  1251: 'Toolhead Extrusion Failed',
  1252: 'Unload Filament At Toolhead Failed',
  1261: 'Toolhead Front Cover Detached',
  1262: 'Cutter Handle Not Released',
  1263: 'Toolhead Extrusion Failed',
  1264: 'Toolhead Extrusion Failed',
  1300: 'Print File Unavailable',
  1301: 'Spaghetti Detected',
  1302: 'Print Defect Detected',
};

// Critical exceptions that typically halt the printer
export const CRITICAL_EXCEPTIONS = new Set([
  101, 102, 103, 104, 105, 106, 107, 108,
  801, 803, 902, 903,
  1103, 1104, 1105, 1106, 1210,
]);
