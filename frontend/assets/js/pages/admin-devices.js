import { callApi } from '../api.js';
import { requireRole } from '../auth.js';
import {
  renderShell, escapeHtml, formatRelative, openFormModal, confirmAction, showToast, showSecretOnce,
} from '../ui.js';
import { mountResourceManager } from '../components/resource-manager.js';
import { badge } from '../components/attendance-ui.js';

const DEVICE_STATUS = {
  active: { label: 'Active', tone: 'success' },
  maintenance: { label: 'Maintenance', tone: 'warning' },
  retired: { label: 'Retired', tone: 'secondary' },
};

const session = requireRole('admin');
if (session) start();

function start() {
  const content = renderShell({ role: 'admin', active: 'devices', title: 'Devices', session });
  content.innerHTML = `
    <div class="page-header">
      <div>
        <h2 class="page-title">Devices</h2>
        <p class="page-subtitle">RFID readers, one active reader per room. A new device starts in maintenance: generate its key, put the key on the device, then activate it.</p>
      </div>
    </div>
    <div id="deviceManager"></div>`;

  // Rooms (for the selects) and the two thresholds (low battery, offline) load with the list.
  let rooms = [];
  let limits = { lowBattery: 3.5, offlineMinutes: 10 };
  const load = async () => {
    const [devices, roomList, settings] = await Promise.all([
      callApi('admin.listDevices'), callApi('admin.listRooms'), callApi('admin.getSettings'),
    ]);
    rooms = roomList.items.filter((room) => room.status === 'active');
    const value = (key, fallback) => Number(settings.items.find((item) => item.key === key)?.value ?? fallback);
    limits = { lowBattery: value('low_battery_voltage', 3.5), offlineMinutes: value('device_offline_after_minutes', 10) };
    return devices;
  };

  const roomOptions = () => rooms.map((room) => ({
    value: room.room_id,
    label: `${room.room_code} · ${room.room_name}${room.device_id ? ` (has ${room.device_id})` : ''}`,
  }));
  const isLive = (row) => row.status !== 'retired';
  // Same rule as the dashboard (deviceSummaries): no battery without a heartbeat inside the offline window.
  const battery = (row) => (!row.last_heartbeat_at || row.battery_voltage === '' || Date.now() - Date.parse(row.last_heartbeat_at) > limits.offlineMinutes * 60000
    ? null : Number(row.battery_voltage));
  const online = (row) => Boolean(row.last_seen_at) && Date.now() - Date.parse(row.last_seen_at) <= limits.offlineMinutes * 60000;

  const setStatus = (row, status, reload) => {
    const texts = {
      active: { title: `Activate ${row.device_id}?`, message: 'It starts accepting RFID taps in its room right away. A room can have only one active device.', label: 'Activate', tone: 'primary' },
      maintenance: { title: `Set ${row.device_id} to maintenance?`, message: 'Its taps are rejected until you activate it again. The key stays the same.', label: 'Set to maintenance', tone: 'primary' },
      retired: { title: `Retire ${row.device_id}?`, message: 'Retired is final and deletes the key: this device can never sign in or be changed again. Its past scans are kept.', label: 'Retire device', tone: 'danger' },
    }[status];
    return runConfirmed({ ...texts, typeToConfirm: status === 'retired' ? row.device_id : '', run: () => callApi('admin.setDeviceStatus', { device_id: row.device_id, status }) })
      .then(async (done) => {
        if (!done) return;
        showToast(`${row.device_id} is now ${DEVICE_STATUS[status].label.toLowerCase()}.`);
        await reload();
      });
  };

  mountResourceManager(document.getElementById('deviceManager'), {
    key: 'devices',
    entity: 'Device',
    entityPlural: 'Devices',
    idField: 'device_id',
    icon: 'router',
    load,
    updateAction: 'admin.updateDevice',
    createAction: 'admin.createDevice',
    nameOf: (row) => row.device_id,
    searchText: (row) => `${row.device_id} ${row.device_name} ${row.room_code} ${row.status} ${row.firmware_version}`,
    columns: [
      { label: 'Device', html: (row) => `<div class="cell-main">${escapeHtml(row.device_name)}</div><div class="cell-sub font-monospace text-nowrap">${escapeHtml(row.device_id)}</div><div class="cell-sub d-sm-none">${row.room_code ? `Room ${escapeHtml(row.room_code)}` : 'No room yet'}</div>` },
      { label: 'Room', hideBelow: 'sm', html: (row) => (row.room_code ? escapeHtml(row.room_code) : '<span class="text-secondary">Unassigned</span>') },
      { label: 'Status', html: (row) => badge(DEVICE_STATUS[row.status] ?? { label: row.status, tone: 'secondary' }) },
      { label: 'Key', hideBelow: 'sm', html: (row) => (row.has_key ? 'Yes' : '<span class="text-danger">No</span>') },
      {
        label: 'Battery',
        hideBelow: 'md',
        html: (row) => {
          const volts = battery(row);
          if (volts === null) return '<span class="text-secondary">—</span>';
          return volts < limits.lowBattery
            ? `<span class="badge text-bg-danger"><i class="bi bi-battery-half me-1" aria-hidden="true"></i>${escapeHtml(volts.toFixed(2))} V · Low</span>`
            : `${escapeHtml(volts.toFixed(2))} V`;
        },
      },
      {
        label: 'Connection',
        hideBelow: 'md',
        html: (row) => `<span class="small text-nowrap"><span class="status-dot ${online(row) ? 'online' : 'offline'}" aria-hidden="true"></span>${online(row) ? 'Online' : 'Offline'}</span>
          <div class="cell-sub">${row.last_seen_at ? `Last seen ${escapeHtml(formatRelative(row.last_seen_at))}` : 'Never connected'}</div>`,
      },
      { label: 'Queue', numeric: true, hideBelow: 'lg', html: (row) => escapeHtml(row.queue_count || '0') },
      { label: 'Firmware', hideBelow: 'lg', html: (row) => (row.firmware_version ? `<span class="small font-monospace">${escapeHtml(row.firmware_version)}</span>` : '<span class="text-secondary">—</span>') },
    ],
    formFields: (row) => [
      { name: 'device_name', label: 'Device name', required: true, maxlength: 80, value: row?.device_name, placeholder: 'Room 301 reader' },
      ...(row ? [] : [{ name: 'room_id', label: 'Room', type: 'select', required: true, options: roomOptions(), help: 'The device ID is made from this room code and never changes. It starts in maintenance.' }]),
      { name: 'notes', label: 'Notes', maxlength: 500, value: row?.notes },
    ],
    savedMessage: (result, editing) => (editing ? 'Device saved.' : `${result.device_id} registered in maintenance. Generate its key next.`),
    extraActions: [
      {
        id: 'room', label: 'Assign room', icon: 'geo-alt',
        show: isLive,
        run: (row, { reload }) => assignRoomFlow(row, roomOptions(), reload),
      },
      {
        id: 'key', label: 'Generate key', icon: 'key',
        show: isLive,
        run: (row, { reload }) => generateKeyFlow(row, reload),
      },
      { id: 'set-active', label: 'Activate', icon: 'check-circle', show: (row) => row.status === 'maintenance', run: (row, { reload }) => setStatus(row, 'active', reload) },
      { id: 'set-maintenance', label: 'Set to maintenance', icon: 'tools', show: (row) => row.status === 'active', run: (row, { reload }) => setStatus(row, 'maintenance', reload) },
      { id: 'set-retired', label: 'Retire', icon: 'archive', show: isLive, run: (row, { reload }) => setStatus(row, 'retired', reload) },
    ],
  });
}

// confirmAction; with typeToConfirm the admin must type that text (e.g. the device ID) first.
async function runConfirmed({ title, message, label, tone, typeToConfirm = '', run }) {
  const { confirmed, data } = await confirmAction({
    title,
    message,
    confirmLabel: label,
    tone,
    reasonLabel: typeToConfirm ? `Type ${typeToConfirm} to confirm` : '',
    run: (values) => {
      if (typeToConfirm && values.reason.trim() !== typeToConfirm) {
        return Promise.reject(Object.assign(new Error(`Type ${typeToConfirm} exactly to confirm.`), { fields: { reason: 'Does not match.' } }));
      }
      return run();
    },
  });
  return confirmed ? data ?? true : null;
}

async function generateKeyFlow(row, reload) {
  const data = await runConfirmed({
    title: `Generate a ${row.has_key ? 'new ' : ''}key for ${row.device_id}?`,
    message: row.has_key
      ? 'The old key stops working immediately: the device cannot send taps or heartbeats until you put the new key on it.'
      : 'You will see the key once. Put it on the device, then activate the device.',
    label: 'Generate key',
    tone: row.has_key ? 'danger' : 'primary',
    typeToConfirm: row.has_key ? row.device_id : '',
    run: () => callApi('admin.generateDeviceKey', { device_id: row.device_id }),
  });
  if (!data) return;
  await showSecretOnce({
    title: `Device key · ${data.device_id}`,
    secret: data.device_key,
    label: 'Device key',
    long: true,
    noteHtml: "Put this in the device's secrets file. It will not be shown again.",
  });
  await reload();
}

async function assignRoomFlow(row, options, reload) {
  const result = await openFormModal({
    title: `Assign room · ${row.device_id}`,
    bodyHtml: `
      <label class="form-label" for="assignRoom">Room</label>
      <select class="form-select" id="assignRoom" name="room_id">
        <option value="">No room (unassigned)</option>
        ${options.map((o) => `<option value="${escapeHtml(o.value)}"${o.value === row.room_id ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
      </select>
      <div class="invalid-feedback" data-error-for="room_id"></div>
      <div class="form-text">The device ID keeps its original room code. An active device cannot move into a room that already has an active device.</div>`,
    submitLabel: 'Save room',
    onSubmit: (values) => callApi('admin.assignDeviceRoom', { device_id: row.device_id, room_id: values.room_id }),
  });
  if (!result) return;
  showToast(result.room_id ? `${row.device_id} assigned.` : `${row.device_id} unassigned.`);
  await reload();
}
