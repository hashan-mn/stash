/* The right-click menu and the "..." settings popover.
 *
 * Both are plain St popups parented to the panel rather than PopupMenu, so
 * they inherit the Modernist styling (square corners, 2px rules) instead of
 * the shell's rounded menu theme.
 */

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

const MENU_WIDTH = 186;
const SETTINGS_WIDTH = 230;

function menuRow(label, trailing, {destructive = false, trailingClass = 'ch-menu-key'} = {}) {
    const button = new St.Button({
        style_class: destructive ? 'ch-menu-item ch-destructive' : 'ch-menu-item',
        x_expand: true,
    });

    const box = new St.BoxLayout({x_expand: true});

    const text = new St.Label({
        text: label,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    box.add_child(text);

    if (trailing) {
        const hint = new St.Label({
            text: trailing,
            style_class: trailingClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
        hint.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(hint);
    }

    button.set_child(box);
    return button;
}

export const ContextMenu = GObject.registerClass({
    Signals: {
        'action': {param_types: [GObject.TYPE_STRING]},
    },
}, class ContextMenu extends St.BoxLayout {
    _init(item) {
        super._init({
            vertical: true,
            style_class: 'ch-popup',
            width: MENU_WIDTH,
            reactive: true,
        });

        const rows = [
            ['paste', 'Paste', 'ENTER', false],
            ['copy', 'Copy again', '', false],
            ['pin', item.pinned ? 'Unpin' : 'Pin to top', 'P', false],
            ['plain', 'Paste as plain text', '', false],
            ['delete', 'Delete', 'DEL', true],
        ];

        for (const [action, label, key, destructive] of rows) {
            const row = menuRow(label, key, {destructive});
            row.connect('clicked', () => {
                this.emit('action', action);
                return Clutter.EVENT_STOP;
            });
            this.add_child(row);
        }
    }

    /** Keep the menu inside the panel's bounds, as the design does. */
    positionWithin(panelWidth, panelHeight, x, y) {
        const width = MENU_WIDTH;
        const height = this.get_preferred_height(width)[1];
        this.set_position(
            Math.max(0, Math.min(x, panelWidth - width)),
            Math.max(0, Math.min(y, panelHeight - height)));
    }
});

export const SettingsPopover = GObject.registerClass({
    Signals: {
        'open-preferences': {},
    },
}, class SettingsPopover extends St.BoxLayout {
    _init(settings) {
        super._init({
            vertical: true,
            style_class: 'ch-popup',
            width: SETTINGS_WIDTH,
            reactive: true,
        });

        const onOff = value => (value ? 'On' : 'Off');

        /* "<Super>v" -> "Super + V". Gtk.accelerator_get_label is not
         * available in the shell process, so format it by hand. */
        const formatAccel = accel => {
            if (!accel)
                return 'Disabled';
            return accel
                .replace(/[<>]/g, ' ')
                .trim()
                .split(/\s+/)
                .map(part => part.charAt(0).toUpperCase() + part.slice(1))
                .join(' + ');
        };

        const shortcut = formatAccel(settings.get_strv('toggle-panel')[0] ?? '');

        const rows = [
            ['History size', `${settings.get_int('history-size')} items`],
            ['Keep after reboot', onOff(settings.get_boolean('keep-after-reboot'))],
            ['Track images', onOff(settings.get_boolean('track-images'))],
            ['Ignore password managers', onOff(settings.get_boolean('ignore-password-managers'))],
            ['Shortcut', shortcut],
        ];

        for (const [label, value] of rows) {
            const row = menuRow(label, value, {trailingClass: 'ch-menu-value'});
            row.reactive = false;
            this.add_child(row);
        }

        const prefs = menuRow('Open preferences', '', {});
        prefs.connect('clicked', () => {
            this.emit('open-preferences');
            return Clutter.EVENT_STOP;
        });
        this.add_child(prefs);
    }
});
