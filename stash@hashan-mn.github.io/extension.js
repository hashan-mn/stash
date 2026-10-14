/* Stash — GNOME Shell extension entry point.
 *
 * enable()/disable() must be perfectly symmetrical: the shell keeps running
 * between them, so anything created here has to be torn down there.
 */

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {ClipboardMonitor} from './src/monitor.js';
import {ClipboardPanel} from './src/ui/panel.js';
import {HistoryStore} from './src/store.js';
import {KeyManager} from './src/keys.js';
import {Paster} from './src/paster.js';
import {Persistence} from './src/persist.js';
import * as Util from './src/util.js';

export default class ClipboardHistoryExtension extends Extension {
    enable() {
        this._settings = this.getSettings();

        Util.setDebug(this._settings.get_boolean('debug-logging'));
        this._debugChangedId = this._settings.connect('changed::debug-logging', () => {
            Util.setDebug(this._settings.get_boolean('debug-logging'));
        });

        this._persist = new Persistence();
        this._persist.ensureDirs();

        this._store = new HistoryStore(this._settings, this._persist);
        this._store.load();
        this._persist.collectGarbage(this._store.all);

        this._monitor = new ClipboardMonitor({
            settings: this._settings,
            onClip: clip => this._store.add(clip),
        });
        this._monitor.start();

        this._paster = new Paster({
            monitor: this._monitor,
            persistence: this._persist,
        });

        this._panel = new ClipboardPanel(this._store, this._settings, this._persist);
        this._panel.connect('item-activated', (_p, id, plainText) =>
            this._onActivated(id, plainText));
        this._panel.connect('item-copied', (_p, id) => this._onCopied(id));
        this._panel.connect('open-preferences', () => this.openPreferences());

        this._keys = new KeyManager(this._settings);
        this._keys.enable(() => this._toggle());

        Util.info(`enabled (v${this.metadata.version}), ${this._store.all.length} items restored`);
    }

    disable() {
        if (this._keys) {
            this._keys.disable();
            this._keys = null;
        }

        if (this._panel) {
            this._panel.destroy();
            this._panel = null;
        }

        if (this._paster) {
            this._paster.destroy();
            this._paster = null;
        }

        if (this._monitor) {
            this._monitor.stop();
            this._monitor = null;
        }

        if (this._store) {
            this._store.flush();
            this._store = null;
        }

        if (this._persist) {
            this._persist.destroy();
            this._persist = null;
        }

        if (this._debugChangedId) {
            this._settings.disconnect(this._debugChangedId);
            this._debugChangedId = null;
        }

        this._settings = null;

        Util.info('disabled');
    }

    _toggle() {
        if (!this._panel)
            return;

        if (this._panel.isOpen) {
            this._panel.close();
            return;
        }

        /* Must happen before the panel takes the keyboard, or the remembered
         * window would be the panel itself. */
        this._paster.rememberFocus();
        this._panel.open();
    }

    _onActivated(id, plainText) {
        const item = this._store.all.find(i => i.id === id);
        if (!item)
            return;

        const targetName = this._paster.focusedAppName;

        this._paster.pasteIntoFocusedWindow(item, plainText, () => this._panel.close());

        Util.debug(`pasted into ${targetName}`);
    }

    _onCopied(id) {
        const item = this._store.all.find(i => i.id === id);
        if (!item)
            return;

        if (this._paster.setClipboard(item))
            this._panel.showToast('Copied to clipboard');
    }
}
