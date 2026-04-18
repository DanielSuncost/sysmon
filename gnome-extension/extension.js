import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const FAST_INTERVAL_SECONDS = 1;
const SLOW_INTERVAL_SECONDS = 5;
const DEFAULT_LABEL = 'C▁▁ R▁▁ G▁▁ V▁▁';
const SPARK_BLOCKS = '▁▂▃▄▅▆▇█';
const HISTORY_LENGTH = 36;
const VISUAL_WIDTH = 156;
const VISUAL_HEIGHT = 18;
const SHOW_TEXT_LABEL = false;

function runCommand(argv) {
    try {
        const [, stdout, stderr, status] = GLib.spawn_sync(
            null,
            argv,
            null,
            GLib.SpawnFlags.SEARCH_PATH,
            null
        );

        if (status !== 0)
            return {ok: false, stdout: '', stderr: bytesToString(stderr)};

        return {ok: true, stdout: bytesToString(stdout), stderr: bytesToString(stderr)};
    } catch (e) {
        return {ok: false, stdout: '', stderr: `${e}`};
    }
}

function bytesToString(bytes) {
    if (!bytes)
        return '';
    return new TextDecoder().decode(bytes).trim();
}

function readFile(path) {
    try {
        const [ok, contents] = GLib.file_get_contents(path);
        if (!ok)
            return '';
        return bytesToString(contents);
    } catch (_) {
        return '';
    }
}

function clampPercent(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(100, value));
}

function spark(percent) {
    const clamped = clampPercent(percent);
    const index = Math.min(SPARK_BLOCKS.length - 1, Math.round((clamped / 100) * (SPARK_BLOCKS.length - 1)));
    return SPARK_BLOCKS[index];
}

function sparkDouble(percent) {
    const first = spark(percent * 0.7);
    const second = spark(percent);
    return `${first}${second}`;
}

function gpuUnavailable() {
    return {available: false, utilization: 0, vramPercent: 0, memoryUsedMb: 0, memoryTotalMb: 0, tempC: 0};
}

class StatsSampler {
    constructor() {
        this._previousCpu = null;
        this._gpuVendor = this._detectGpuVendor();
    }

    _detectGpuVendor() {
        if (runCommand(['nvidia-smi', '--query-gpu=name', '--format=csv,noheader']).ok)
            return 'nvidia';
        if (runCommand(['rocm-smi', '--version']).ok)
            return 'amd';
        return null;
    }

    sample() {
        const cpu = this._getCpuPercent();
        const ram = this._getRamPercent();
        const gpu = this._getGpuStats();
        return {cpu, ram, gpu};
    }

    getTopProcesses() {
        return {
            cpu: this._getTopProcesses('%cpu'),
            ram: this._getTopProcesses('rss'),
            gpu: this._getGpuProcesses(),
        };
    }

    _getCpuPercent() {
        const stat = readFile('/proc/stat').split('\n')[0]?.trim();
        if (!stat)
            return 0;

        const parts = stat.split(/\s+/).slice(1).map(v => Number.parseInt(v, 10));
        if (parts.length < 4 || parts.some(Number.isNaN))
            return 0;

        const idle = (parts[3] || 0) + (parts[4] || 0);
        const total = parts.reduce((sum, value) => sum + value, 0);
        const current = {idle, total};

        if (!this._previousCpu) {
            this._previousCpu = current;
            return 0;
        }

        const totalDelta = current.total - this._previousCpu.total;
        const idleDelta = current.idle - this._previousCpu.idle;
        this._previousCpu = current;

        if (totalDelta <= 0)
            return 0;

        return clampPercent((1 - idleDelta / totalDelta) * 100);
    }

    _getRamPercent() {
        const lines = readFile('/proc/meminfo').split('\n');
        let totalKb = 0;
        let availableKb = 0;

        for (const line of lines) {
            if (line.startsWith('MemTotal:'))
                totalKb = Number.parseInt(line.replace(/\D+/g, ' ').trim().split(' ')[0], 10);
            else if (line.startsWith('MemAvailable:'))
                availableKb = Number.parseInt(line.replace(/\D+/g, ' ').trim().split(' ')[0], 10);
        }

        if (!totalKb)
            return 0;

        const used = totalKb - availableKb;
        return clampPercent((used / totalKb) * 100);
    }

    _getGpuStats() {
        if (this._gpuVendor === 'nvidia')
            return this._getNvidiaGpuStats();
        if (this._gpuVendor === 'amd')
            return this._getAmdGpuStats();
        return gpuUnavailable();
    }

    _getNvidiaGpuStats() {
        const result = runCommand([
            'nvidia-smi',
            '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu',
            '--format=csv,noheader,nounits',
        ]);

        if (!result.ok || !result.stdout)
            return gpuUnavailable();

        const first = result.stdout.split('\n')[0]?.trim();
        if (!first)
            return gpuUnavailable();

        const [utilStr, usedStr, totalStr, tempStr] = first.split(',').map(s => s.trim());
        const utilization = Number.parseFloat(utilStr);
        const memoryUsedMb = Number.parseFloat(usedStr);
        const memoryTotalMb = Number.parseFloat(totalStr);
        const tempC = Number.parseFloat(tempStr);
        const vramPercent = memoryTotalMb > 0 ? (memoryUsedMb / memoryTotalMb) * 100 : 0;

        return {
            available: true,
            utilization: clampPercent(utilization),
            vramPercent: clampPercent(vramPercent),
            memoryUsedMb: Number.isFinite(memoryUsedMb) ? memoryUsedMb : 0,
            memoryTotalMb: Number.isFinite(memoryTotalMb) ? memoryTotalMb : 0,
            tempC: Number.isFinite(tempC) ? tempC : 0,
        };
    }

    _getAmdGpuStats() {
        // rocm-smi --csv reports VRAM in bytes; temperature header varies by sensor
        // (e.g. "Temperature (Sensor edge) (C)") so we match by prefix.
        const result = runCommand([
            'rocm-smi',
            '--showuse', '--showmeminfo', 'vram', '--showtemp',
            '--csv',
        ]);

        if (!result.ok || !result.stdout)
            return gpuUnavailable();

        const lines = result.stdout.split('\n').filter(l => l.trim());
        if (lines.length < 2)
            return gpuUnavailable();

        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const values = lines[1].split(',').map(v => v.trim());

        const col = keyword => {
            const i = headers.findIndex(h => h.includes(keyword));
            return i >= 0 ? values[i] : null;
        };

        const utilization = Number.parseFloat(col('gpu use') ?? '0');
        const memTotalB = Number.parseFloat(col('vram total memory') ?? '0');
        const memUsedB = Number.parseFloat(col('vram total used') ?? '0');
        const tempC = Number.parseFloat(col('temperature') ?? '0');
        const memoryTotalMb = memTotalB / (1024 * 1024);
        const memoryUsedMb = memUsedB / (1024 * 1024);
        const vramPercent = memoryTotalMb > 0 ? (memoryUsedMb / memoryTotalMb) * 100 : 0;

        return {
            available: true,
            utilization: clampPercent(Number.isFinite(utilization) ? utilization : 0),
            vramPercent: clampPercent(vramPercent),
            memoryUsedMb: Number.isFinite(memoryUsedMb) ? memoryUsedMb : 0,
            memoryTotalMb: Number.isFinite(memoryTotalMb) ? memoryTotalMb : 0,
            tempC: Number.isFinite(tempC) ? tempC : 0,
        };
    }

    _getTopProcesses(sortKey) {
        const sortArg = sortKey === 'rss' ? '--sort=-rss' : '--sort=-%cpu';
        const result = runCommand([
            'bash', '-lc',
            `ps -eo pid,comm,%cpu,rss ${sortArg} | head -n 6`,
        ]);

        if (!result.ok || !result.stdout)
            return [];

        const lines = result.stdout.split('\n').slice(1);
        const rows = [];
        for (const line of lines) {
            const parts = line.trim().split(/\s+/, 4);
            if (parts.length < 4)
                continue;
            rows.push({
                pid: parts[0],
                name: parts[1],
                cpu: Number.parseFloat(parts[2]) || 0,
                rssKb: Number.parseInt(parts[3], 10) || 0,
            });
        }
        return rows;
    }

    _getGpuProcesses() {
        if (this._gpuVendor === 'nvidia')
            return this._getNvidiaGpuProcesses();
        if (this._gpuVendor === 'amd')
            return this._getAmdGpuProcesses();
        return [];
    }

    _getNvidiaGpuProcesses() {
        const result = runCommand([
            'nvidia-smi',
            '--query-compute-apps=pid,process_name,used_gpu_memory',
            '--format=csv,noheader,nounits',
        ]);

        if (!result.ok || !result.stdout)
            return [];

        const rows = [];
        for (const line of result.stdout.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            const parts = trimmed.split(',').map(v => v.trim());
            if (parts.length < 3)
                continue;
            rows.push({
                pid: parts[0],
                name: parts[1],
                usedMb: Number.parseInt(parts[2], 10) || 0,
            });
        }
        return rows;
    }

    _getAmdGpuProcesses() {
        // rocm-smi --showpids --csv columns: PID, PPID, Name, GPU, VRAM (B)
        const result = runCommand(['rocm-smi', '--showpids', '--csv']);

        if (!result.ok || !result.stdout)
            return [];

        const lines = result.stdout.split('\n').filter(l => l.trim());
        if (lines.length < 2)
            return [];

        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const rows = [];

        for (const line of lines.slice(1)) {
            const parts = line.split(',').map(v => v.trim());
            if (parts.length < headers.length)
                continue;

            const col = keyword => {
                const i = headers.findIndex(h => h.includes(keyword));
                return i >= 0 ? parts[i] : '';
            };

            const pid = col('pid');
            const name = col('name') || col('process');
            const vramB = Number.parseFloat(col('vram')) || 0;

            if (!pid || !name)
                continue;

            rows.push({pid, name, usedMb: Math.round(vramB / (1024 * 1024))});
        }
        return rows;
    }
}

const SysMonIndicator = GObject.registerClass(
class SysMonIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'SysMon');

        this._sampler = new StatsSampler();
        this._fastTimer = null;
        this._slowTimer = null;
        this._cpuHistory = [];
        this._gpuHistory = [];
        this._lastStats = {
            cpu: 0,
            ram: 0,
            gpu: {available: false, utilization: 0, vramPercent: 0, memoryUsedMb: 0, memoryTotalMb: 0, tempC: 0},
        };

        this._panelBox = new St.BoxLayout({
            style_class: 'panel-button',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._visual = new St.DrawingArea({
            style_class: 'sysmon-visual',
            width: VISUAL_WIDTH,
            height: VISUAL_HEIGHT,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._visual.connect('repaint', area => this._drawVisual(area));
        this._panelBox.add_child(this._visual);

        this._label = null;
        if (SHOW_TEXT_LABEL) {
            this._label = new St.Label({
                text: DEFAULT_LABEL,
                y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 10px; margin-left: 6px;',
            });
            this._panelBox.add_child(this._label);
        }
        this.add_child(this._panelBox);

        this._gpuSummaryItem = new PopupMenu.PopupMenuItem('GPU: --', {reactive: false});
        this._ramSummaryItem = new PopupMenu.PopupMenuItem('RAM: --', {reactive: false});
        this._cpuSummaryItem = new PopupMenu.PopupMenuItem('CPU: --', {reactive: false});
        this.menu.addMenuItem(this._cpuSummaryItem);
        this.menu.addMenuItem(this._ramSummaryItem);
        this.menu.addMenuItem(this._gpuSummaryItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._topCpuSection = new PopupMenu.PopupSubMenuMenuItem('Top CPU Processes');
        this._topRamSection = new PopupMenu.PopupSubMenuMenuItem('Top RAM Processes');
        this._topGpuSection = new PopupMenu.PopupSubMenuMenuItem('GPU Compute Processes');
        this.menu.addMenuItem(this._topCpuSection);
        this.menu.addMenuItem(this._topRamSection);
        this.menu.addMenuItem(this._topGpuSection);

        this._statusItem = new PopupMenu.PopupMenuItem('Refreshing…', {reactive: false});
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addMenuItem(this._statusItem);

        this._refreshFast();
        this._refreshSlow();

        this._fastTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, FAST_INTERVAL_SECONDS, () => {
            this._refreshFast();
            return GLib.SOURCE_CONTINUE;
        });

        this._slowTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SLOW_INTERVAL_SECONDS, () => {
            this._refreshSlow();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._fastTimer) {
            GLib.source_remove(this._fastTimer);
            this._fastTimer = null;
        }
        if (this._slowTimer) {
            GLib.source_remove(this._slowTimer);
            this._slowTimer = null;
        }
        super.destroy();
    }

    _pushHistory(history, value) {
        history.push(clampPercent(value));
        while (history.length > HISTORY_LENGTH)
            history.shift();
    }

    _refreshFast() {
        const stats = this._sampler.sample();
        this._lastStats = stats;
        this._pushHistory(this._cpuHistory, stats.cpu);
        this._pushHistory(this._gpuHistory, stats.gpu.available ? stats.gpu.utilization : 0);

        if (this._label) {
            const gpuUsageText = stats.gpu.available ? `${Math.round(stats.gpu.utilization)}` : '--';
            const vramUsageText = stats.gpu.available ? `${Math.round(stats.gpu.vramPercent)}` : '--';
            this._label.set_text(`C${Math.round(stats.cpu)} R${Math.round(stats.ram)} G${gpuUsageText} V${vramUsageText}`);
        }
        this._visual.queue_repaint();

        this._cpuSummaryItem.label.text = `CPU: ${stats.cpu.toFixed(1)}%`;
        this._ramSummaryItem.label.text = `RAM: ${stats.ram.toFixed(1)}%`;
        if (stats.gpu.available) {
            this._gpuSummaryItem.label.text = `GPU: ${stats.gpu.utilization.toFixed(1)}% · VRAM ${stats.gpu.memoryUsedMb.toFixed(0)}/${stats.gpu.memoryTotalMb.toFixed(0)} MiB · ${stats.gpu.tempC.toFixed(0)}°C`;
        } else {
            this._gpuSummaryItem.label.text = 'GPU: unavailable';
        }
        this._statusItem.label.text = `Updated ${new Date().toLocaleTimeString()}`;
    }

    _refreshSlow() {
        const top = this._sampler.getTopProcesses();
        this._setSubmenuItems(this._topCpuSection.menu, top.cpu.map(p => `${p.name} (${p.pid}) · ${p.cpu.toFixed(1)}% CPU`), 'No process data');
        this._setSubmenuItems(this._topRamSection.menu, top.ram.map(p => `${p.name} (${p.pid}) · ${(p.rssKb / 1024 / 1024).toFixed(2)} GiB`), 'No process data');
        this._setSubmenuItems(this._topGpuSection.menu, top.gpu.map(p => `${p.name} (${p.pid}) · ${p.usedMb} MiB`), 'No GPU compute processes');
    }

    _drawVisual(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();

        cr.setOperator(Cairo.Operator.CLEAR);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        this._drawPanelBackground(cr, width, height);

        const gap = 4;
        const sectionWidth = Math.floor((width - gap * 3) / 4);
        let x = 0;
        this._drawHistoryPanel(cr, x, 0, sectionWidth, height, this._cpuHistory, [0.40, 0.70, 1.00], [0.15, 0.45, 0.95], 'C');
        x += sectionWidth + gap;
        this._drawMeterPanel(cr, x, 0, sectionWidth, height, this._lastStats.ram, [0.80, 0.90, 1.00], 'R');
        x += sectionWidth + gap;
        this._drawHistoryPanel(cr, x, 0, sectionWidth, height, this._gpuHistory, [0.55, 0.95, 0.55], [0.10, 0.75, 0.25], 'G');
        x += sectionWidth + gap;
        this._drawMeterPanel(cr, x, 0, sectionWidth, height, this._lastStats.gpu.available ? this._lastStats.gpu.vramPercent : 0, [1.00, 0.88, 0.45], 'V');

        cr.$dispose();
    }

    _drawPanelBackground(cr, width, height) {
        cr.setSourceRGBA(0.08, 0.08, 0.08, 0.18);
        this._roundedRect(cr, 0.5, 0.5, width - 1, height - 1, 4);
        cr.fill();
    }

    _drawHistoryPanel(cr, x, y, width, height, history, fillRgb, lineRgb, label) {
        this._drawCard(cr, x, y, width, height);
        const innerX = x + 2;
        const innerY = y + 2;
        const innerW = width - 4;
        const innerH = height - 4;
        const baseY = innerY + innerH;

        if (history.length >= 2) {
            const points = [];
            const span = Math.max(1, history.length - 1);
            for (let i = 0; i < history.length; i++) {
                const value = clampPercent(history[i]);
                const px = innerX + (i * innerW / span);
                const py = innerY + innerH - (value / 100) * innerH;
                points.push([px, py]);
            }

            cr.setSourceRGBA(fillRgb[0], fillRgb[1], fillRgb[2], 0.25);
            cr.moveTo(points[0][0], baseY);
            for (const [px, py] of points)
                cr.lineTo(px, py);
            cr.lineTo(points[points.length - 1][0], baseY);
            cr.closePath();
            cr.fill();

            cr.setSourceRGBA(lineRgb[0], lineRgb[1], lineRgb[2], 0.95);
            cr.setLineWidth(1.4);
            cr.moveTo(points[0][0], points[0][1]);
            for (const [px, py] of points.slice(1))
                cr.lineTo(px, py);
            cr.stroke();
        }

        this._drawCornerLabel(cr, x, y, label);
    }

    _drawMeterPanel(cr, x, y, width, height, percent, fillRgb, label) {
        const clamped = clampPercent(percent);
        const cx = x + width / 2;
        const cy = y + height / 2 + 0.25;
        const radius = Math.min(width, height) / 2 - 1.8;
        const ringRadius = radius - 1.4;
        const innerRadius = Math.max(2, ringRadius - 3.2);
        const start = -Math.PI / 2;
        const end = start + (2 * Math.PI * clamped / 100);

        // Base donut track, no outer card.
        cr.setLineWidth(3.2);
        cr.setSourceRGBA(1, 1, 1, 0.14);
        cr.newSubPath();
        cr.arc(cx, cy, ringRadius, 0, 2 * Math.PI);
        cr.stroke();

        // Filled arc.
        if (clamped > 0) {
            cr.setSourceRGBA(fillRgb[0], fillRgb[1], fillRgb[2], 0.82);
            cr.newSubPath();
            cr.arc(cx, cy, ringRadius, start, end);
            cr.stroke();
        }

        // Subtle inner definition.
        cr.setLineWidth(1.0);
        cr.setSourceRGBA(0, 0, 0, 0.26);
        cr.newSubPath();
        cr.arc(cx, cy, innerRadius, 0, 2 * Math.PI);
        cr.stroke();

        this._drawCornerLabel(cr, x, y, label);
    }

    _drawCard(cr, x, y, width, height) {
        cr.setSourceRGBA(1, 1, 1, 0.18);
        this._roundedRect(cr, x + 0.5, y + 0.5, width - 1, height - 1, 3);
        cr.stroke();
    }

    _drawCornerLabel(cr, x, y, label) {
        const badgeX = x + 2.5;
        const badgeY = y + 2.0;
        const badgeW = 10.5;
        const badgeH = 8.5;

        // Small dark badge so the label stays legible over both empty and filled meters.
        cr.setSourceRGBA(0, 0, 0, 0.30);
        this._roundedRect(cr, badgeX, badgeY, badgeW, badgeH, 2);
        cr.fill();

        cr.setSourceRGBA(1, 1, 1, 0.55);
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(8);
        cr.moveTo(x + 4.5, y + 9);
        cr.showText(label);
    }

    _roundedRect(cr, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height / 2);
        cr.newSubPath();
        cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
        cr.closePath();
    }

    _setSubmenuItems(menu, labels, emptyLabel) {
        menu.removeAll();
        const rows = labels.length > 0 ? labels : [emptyLabel];
        for (const label of rows)
            menu.addMenuItem(new PopupMenu.PopupMenuItem(label, {reactive: false}));
    }
});

export default class SysMonExtension extends Extension {
    enable() {
        this._indicator = new SysMonIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
