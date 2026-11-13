// MemoBrOS Pointer: a small GNOME Shell extension that draws the assistant's pointer above all windows.
//
// What it does: exposes a D-Bus service on the user's session bus (org.memobros.Pointer) with a handful of drawing
// calls, and draws three non-interactive actors: the assistant pointer, a text label and a highlight frame.
// What it does not do: it never injects clicks or keys, never reads window contents, never captures the screen,
// and never moves or replaces the real mouse cursor. The only thing it reads is the pointer position, to follow it.
// Safety: everything it draws is click-through, and it hides itself when MemoBrOS has not pinged it for 15 seconds.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'org.memobros.Pointer';
const OBJECT_PATH = '/org/memobros/Pointer';
const INTERFACE = `
<node>
  <interface name="org.memobros.Pointer">
    <method name="Ping"><arg type="s" direction="out" name="version"/></method>
    <method name="SetFollow">
      <arg type="b" direction="in" name="enabled"/><arg type="s" direction="in" name="icon"/>
      <arg type="i" direction="in" name="offsetX"/><arg type="i" direction="in" name="offsetY"/><arg type="i" direction="in" name="size"/>
    </method>
    <method name="PointAt">
      <arg type="i" direction="in" name="x"/><arg type="i" direction="in" name="y"/>
      <arg type="s" direction="in" name="label"/><arg type="i" direction="in" name="seconds"/>
    </method>
    <method name="Highlight">
      <arg type="i" direction="in" name="x"/><arg type="i" direction="in" name="y"/>
      <arg type="i" direction="in" name="width"/><arg type="i" direction="in" name="height"/>
      <arg type="s" direction="in" name="label"/><arg type="i" direction="in" name="seconds"/>
    </method>
    <method name="Clear"/>
    <method name="GetMonitors"><arg type="s" direction="out" name="json"/></method>
  </interface>
</node>`;
const MARK = '#ff4d5e';
const SILENCE_SECONDS = 15; // without a ping for this long, MemoBrOS is assumed gone

export default class MemoBrOSPointer extends Extension {
    enable() {
        this._follow = false;
        this._offset = [14, 16];
        this._guidingUntil = 0;
        this._lastPing = 0;
        this._timers = [];

        // Non-reactive actors added straight to the shell's top group: drawn above windows, and input passes through.
        this._pointer = new St.Icon({reactive: false, visible: false, icon_size: 48});
        this._label = new St.Label({reactive: false, visible: false,
            style: `background-color: ${MARK}; color: white; font-weight: bold; border-radius: 9px; padding: 4px 10px;`});
        this._frame = new St.Widget({reactive: false, visible: false,
            style: `border: 3px solid ${MARK}; border-radius: 10px;`});
        for (const actor of [this._frame, this._pointer, this._label])
            Main.uiGroup.add_child(actor);

        this._dbus = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this);
        this._dbus.export(Gio.DBus.session, OBJECT_PATH);
        this._nameId = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);

        // Follow the real pointer, and watch for MemoBrOS going away.
        this._timers.push(GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            if (this._follow && this._now() >= this._guidingUntil) {
                const [x, y] = global.get_pointer();
                this._pointer.set_position(x + this._offset[0], y + this._offset[1]);
            }
            return GLib.SOURCE_CONTINUE;
        }));
        this._timers.push(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
            if (this._lastPing && this._now() - this._lastPing > SILENCE_SECONDS)
                this._hideAll();
            return GLib.SOURCE_CONTINUE;
        }));
    }

    disable() {
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = [];
        if (this._nameId) {
            Gio.bus_unown_name(this._nameId);
            this._nameId = 0;
        }
        this._dbus?.unexport();
        this._dbus = null;
        for (const actor of [this._frame, this._pointer, this._label])
            actor?.destroy();
        this._frame = this._pointer = this._label = null;
    }

    _now() {
        return GLib.get_monotonic_time() / 1000000;
    }

    _hideAll() {
        this._follow = false;
        this._guidingUntil = 0;
        this._lastPing = 0;
        this._pointer.hide();
        this._label.hide();
        this._frame.hide();
    }

    _showLabel(text, x, y) {
        if (!text) {
            this._label.hide();
            return;
        }
        this._label.set_text(text);
        this._label.set_position(x, y);
        this._label.show();
    }

    // ---- D-Bus methods -------------------------------------------------------------------
    Ping() {
        this._lastPing = this._now();
        return '1';
    }

    SetFollow(enabled, icon, offsetX, offsetY, size) {
        this._lastPing = this._now();
        this._follow = enabled;
        this._offset = [offsetX, offsetY];
        if (icon && GLib.file_test(icon, GLib.FileTest.EXISTS))
            this._pointer.set_gicon(Gio.icon_new_for_string(icon));
        if (size > 0)
            this._pointer.set_icon_size(size);
        if (enabled)
            this._pointer.show();
        else if (this._now() >= this._guidingUntil)
            this._pointer.hide();
    }

    PointAt(x, y, label, seconds) {
        this._lastPing = this._now();
        const until = this._now() + Math.max(1, seconds);
        this._guidingUntil = until;
        this._pointer.show();
        this._pointer.ease({x, y, duration: 450, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        this._showLabel(label, x + this._pointer.icon_size + 6, y + 2);
        this._timers.push(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(1, seconds), () => {
            if (this._pointer && this._guidingUntil === until) {
                this._guidingUntil = 0;
                this._label.hide();
                if (!this._follow)
                    this._pointer.hide();
            }
            return GLib.SOURCE_REMOVE;
        }));
    }

    Highlight(x, y, width, height, label, seconds) {
        this._lastPing = this._now();
        this._frame.set_position(x - 6, y - 6);
        this._frame.set_size(width + 12, height + 12);
        this._frame.show();
        if (label)
            this._showLabel(label, x - 6, Math.max(0, y - 34));
        const frame = this._frame;
        this._timers.push(GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(1, seconds), () => {
            if (this._frame === frame)
                frame.hide();
            return GLib.SOURCE_REMOVE;
        }));
    }

    Clear() {
        this._lastPing = this._now();
        this._guidingUntil = 0;
        this._label.hide();
        this._frame.hide();
        if (!this._follow)
            this._pointer.hide();
    }

    GetMonitors() {
        const [px, py] = global.get_pointer();
        const monitors = [];
        for (let i = 0; i < global.display.get_n_monitors(); i++) {
            const g = global.display.get_monitor_geometry(i);
            monitors.push({x: g.x, y: g.y, width: g.width, height: g.height,
                scale: global.display.get_monitor_scale(i),
                primary: i === global.display.get_primary_monitor(),
                current: px >= g.x && px < g.x + g.width && py >= g.y && py < g.y + g.height});
        }
        return JSON.stringify({monitors});
    }
}
