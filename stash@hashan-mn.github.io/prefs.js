/* Preferences window (libadwaita).
 *
 * Runs in its own process, not in gnome-shell, so it can only talk to the
 * extension through GSettings.
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from
    'resource:///org/gnome/shell/extensions/prefs.js';

const THEMES = [
    ['dark', 'Dark'],
    ['light', 'Light'],
    ['system', 'Follow system'],
];

/** "<Super>v" -> "Super+V" for display. */
function accelToLabel(accel) {
    if (!accel)
        return 'Disabled';
    const [ok, key, mods] = Gtk.accelerator_parse(accel);
    if (!ok)
        return accel;
    return Gtk.accelerator_get_label(key, mods);
}

/**
 * Modal that captures the next key combination.
 * GNOME has no reusable shortcut-capture widget for extensions, so this is a
 * small purpose-built one.
 */
const ShortcutDialog = GObject.registerClass({
    Signals: {'shortcut-set': {param_types: [GObject.TYPE_STRING]}},
}, class ShortcutDialog extends Adw.Window {
    _init(parent) {
        super._init({
            transient_for: parent,
            modal: true,
            hide_on_close: true,
            width_request: 420,
            height_request: 220,
            title: 'Set Shortcut',
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 36,
            margin_bottom: 36,
            margin_start: 36,
            margin_end: 36,
            valign: Gtk.Align.CENTER,
        });

        box.append(new Gtk.Label({
            label: '<b>Press the new shortcut</b>',
            use_markup: true,
        }));
        box.append(new Gtk.Label({
            label: 'Esc to cancel, Backspace to disable.',
            css_classes: ['dim-label'],
        }));

        const content = new Adw.ToolbarView({content: box});
        content.add_top_bar(new Adw.HeaderBar({show_end_title_buttons: false}));
        this.set_content(content);

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();

            if (keyval === Gdk.KEY_Escape && mask === 0) {
                this.close();
                return Gdk.EVENT_STOP;
            }

            if (keyval === Gdk.KEY_BackSpace && mask === 0) {
                this.emit('shortcut-set', '');
                this.close();
                return Gdk.EVENT_STOP;
            }

            /* A modifier on its own is not a shortcut. */
            if (!this._isValidBinding(mask, keycode, keyval))
                return Gdk.EVENT_STOP;

            const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
            this.emit('shortcut-set', accel);
            this.close();
            return Gdk.EVENT_STOP;
        });
        this.add_controller(controller);
    }

    _isValidBinding(mask, keycode, keyval) {
        if (mask === 0)
            return false;
        if (mask === Gdk.ModifierType.SHIFT_MASK && keycode !== 0) {
            if ((keyval >= Gdk.KEY_a && keyval <= Gdk.KEY_z) ||
                (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) ||
                (keyval >= Gdk.KEY_0 && keyval <= Gdk.KEY_9))
                return false;
        }
        return true;
    }
});

export default class ClipboardHistoryPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        window.add(this._historyPage(settings, window));
        window.add(this._privacyPage(settings));
    }

    /* ---------------------------------------------------------- history --- */

    _historyPage(settings, window) {
        const page = new Adw.PreferencesPage({
            title: _('History'),
            icon_name: 'edit-paste-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: _('History'),
            description: _('Pinned entries are never evicted, whatever these are set to.'),
        });
        page.add(group);

        const size = new Adw.SpinRow({
            title: _('History size'),
            subtitle: _('How many unpinned entries to keep'),
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 1000,
                step_increment: 10,
                page_increment: 50,
                value: settings.get_int('history-size'),
            }),
        });
        group.add(size);
        settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);

        const persist = new Adw.SwitchRow({
            title: _('Keep after reboot'),
            subtitle: _('Write history to disk so it survives logout'),
        });
        group.add(persist);
        settings.bind('keep-after-reboot', persist, 'active', Gio.SettingsBindFlags.DEFAULT);

        const appearance = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(appearance);

        const theme = new Adw.ComboRow({
            title: _('Theme'),
            model: Gtk.StringList.new(THEMES.map(([, label]) => label)),
            selected: Math.max(0, THEMES.findIndex(
                ([key]) => key === settings.get_string('theme'))),
        });
        theme.connect('notify::selected', () => {
            settings.set_string('theme', THEMES[theme.selected][0]);
        });
        appearance.add(theme);

        const shortcuts = new Adw.PreferencesGroup({
            title: _('Shortcut'),
            description: _(
                'Super+V is bound to the message tray by default. Taking it ' +
                'leaves Super+M for the tray, and the original binding is ' +
                'restored when this extension is disabled.'),
        });
        page.add(shortcuts);

        const shortcutRow = new Adw.ActionRow({
            title: _('Open the panel'),
            subtitle: accelToLabel(settings.get_strv('toggle-panel')[0]),
        });
        const changeButton = new Gtk.Button({
            label: _('Change'),
            valign: Gtk.Align.CENTER,
        });
        shortcutRow.add_suffix(changeButton);
        shortcutRow.activatable_widget = changeButton;
        shortcuts.add(shortcutRow);

        changeButton.connect('clicked', () => {
            const dialog = new ShortcutDialog(window);
            dialog.connect('shortcut-set', (_d, accel) => {
                settings.set_strv('toggle-panel', accel ? [accel] : []);
                shortcutRow.subtitle = accelToLabel(accel);
            });
            dialog.present();
        });

        return page;
    }

    /* ---------------------------------------------------------- privacy --- */

    _privacyPage(settings) {
        const page = new Adw.PreferencesPage({
            title: _('Privacy'),
            icon_name: 'channel-secure-symbolic',
        });

        const warning = new Adw.PreferencesGroup();
        warning.add(new Adw.ActionRow({
            title: _('History is stored unencrypted'),
            subtitle: _(
                'Entries are written to ~/.local/share/stash in ' +
                'plain text. Anything you copy, including passwords and ' +
                'tokens, can be read by any process running as you.'),
            css_classes: ['warning'],
        }));
        page.add(warning);

        const group = new Adw.PreferencesGroup({title: _('What gets recorded')});
        page.add(group);

        const images = new Adw.SwitchRow({
            title: _('Track images'),
            subtitle: _('Record screenshots and copied images'),
        });
        group.add(images);
        settings.bind('track-images', images, 'active', Gio.SettingsBindFlags.DEFAULT);

        const maxImage = new Adw.SpinRow({
            title: _('Maximum image size'),
            subtitle: _('Megabytes; larger images are ignored'),
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 64,
                step_increment: 1,
                page_increment: 4,
                value: Math.round(settings.get_int('max-image-bytes') / (1024 * 1024)),
            }),
        });
        maxImage.connect('notify::value', () => {
            settings.set_int('max-image-bytes', maxImage.value * 1024 * 1024);
        });
        group.add(maxImage);

        const passwords = new Adw.SwitchRow({
            title: _('Ignore password managers'),
            subtitle: _('Skip clipboard content marked as sensitive'),
        });
        group.add(passwords);
        settings.bind('ignore-password-managers', passwords, 'active',
            Gio.SettingsBindFlags.DEFAULT);

        const blocklist = new Adw.EntryRow({
            title: _('Never record these apps'),
            text: settings.get_strv('app-blocklist').join(', '),
            show_apply_button: true,
        });
        blocklist.connect('apply', () => {
            const apps = blocklist.text
                .split(',')
                .map(s => s.trim())
                .filter(s => s.length > 0);
            settings.set_strv('app-blocklist', apps);
        });
        group.add(blocklist);

        const troubleshooting = new Adw.PreferencesGroup({title: _('Troubleshooting')});
        page.add(troubleshooting);

        const debug = new Adw.SwitchRow({
            title: _('Verbose logging'),
            subtitle: _('Log clipboard events to the journal'),
        });
        troubleshooting.add(debug);
        settings.bind('debug-logging', debug, 'active', Gio.SettingsBindFlags.DEFAULT);

        return page;
    }
}
