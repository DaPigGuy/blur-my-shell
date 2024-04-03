import Meta from 'gi://Meta';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

import { PipelinesManager } from './conveniences/pipelines_manager.js';
import { EffectsManager } from './conveniences/effects_manager.js';
import { Connections } from './conveniences/connections.js';
import { Settings } from './conveniences/settings.js';
import { Keys } from './conveniences/keys.js';

import { PanelBlur } from './components/panel.js';
import { OverviewBlur } from './components/overview.js';
import { DashBlur } from './components/dash_to_dock.js';
import { LockscreenBlur } from './components/lockscreen.js';
import { AppFoldersBlur } from './components/appfolders.js';
import { WindowListBlur } from './components/window_list.js';
import { ApplicationsBlur } from './components/applications.js';
import { ScreenshotBlur } from './components/screenshot.js';

// This lists the components that need to be connected in order to either use
// general sigma/brightness or their own.
const INDEPENDENT_COMPONENTS = [
    "overview", "appfolder", "panel", "dash_to_dock", "applications",
    "lockscreen", "window_list", "screenshot"
];


/// The main extension class, created when the GNOME Shell is loaded.
export default class BlurMyShell extends Extension {
    /// Enables the extension.
    enable() {
        // add the extension to global to make it accessible to other extensions
        // create it first as it is very useful when debugging crashes
        global.blur_my_shell = this;

        // create a Settings instance, to manage extension's preferences
        // it needs to be loaded before logging, as it checks for DEBUG
        this._settings = new Settings(Keys, this.getSettings());

        this._log("enabling extension...");

        // create main extension Connections instance
        this._connection = new Connections;

        // store it in a global array
        this._connections = [this._connection];

        // create a global effects manager (to prevent RAM bleeding)
        this._effects_manager = new EffectsManager(this._connection);

        // create a global pipelines manager, that helps talking with preferences
        this._pipelines_manager = new PipelinesManager(this._settings);

        // create an instance of each component, with its associated Connections
        let init = _ => {
            // create a Connections instance, to manage signals
            let connection = new Connections;

            // store it to keeps track of them globally
            this._connections.push(connection);

            return [connection, this._settings, this._effects_manager];
        };

        this._panel_blur = new PanelBlur(...init());
        this._dash_to_dock_blur = new DashBlur(...init());
        this._overview_blur = new OverviewBlur(...init());
        this._lockscreen_blur = new LockscreenBlur(...init());
        this._appfolder_blur = new AppFoldersBlur(...init());
        this._window_list_blur = new WindowListBlur(...init());
        this._applications_blur = new ApplicationsBlur(...init());
        this._screenshot_blur = new ScreenshotBlur(...init());

        // connect each component to preferences change
        this._connect_to_settings();

        // enable the lockscreen blur, only one important in both `user` session and `unlock-dialog`
        if (this._settings.lockscreen.BLUR && !this._lockscreen_blur.enabled)
            this._lockscreen_blur.enable();

        // ensure we take the correct action for the current session mode
        this._user_session_mode_enabled = false;
        this._on_session_mode_changed(Main.sessionMode);

        // watch for changes to the session mode
        this._connection.connect(Main.sessionMode, 'updated',
            _ => this._on_session_mode_changed(Main.sessionMode)
        );
    }

    /// Enables the components related to the user session (everything except lockscreen blur).
    _enable_user_session() {
        this._log("changing mode to user session...");

        // maybe disable clipped redraw
        this._update_clipped_redraws();

        // enable every component
        // if the shell is still starting up, wait for it to be entirely loaded;
        // this should prevent bugs like #136 and #137
        if (Main.layoutManager._startingUp) {
            this._connection.connect(
                Main.layoutManager,
                'startup-complete',
                this._enable_components.bind(this)
            );
        } else
            this._enable_components();

        // try to enable the components as soon as possible anyway, this way the
        // overview may load before the user sees it
        try {
            if (this._settings.overview.BLUR && !this._overview_blur.enabled)
                this._overview_blur.enable();
        } catch (e) {
            this._log("Could not enable overview blur directly");
            this._log(e);
        }
        try {
            if (this._settings.dash_to_dock.BLUR
                && !this._dash_to_dock_blur.enabled)
                this._dash_to_dock_blur.enable();
        } catch (e) {
            this._log("Could not enable dash-to-dock blur directly");
            this._log(e);
        }
        try {
            if (this._settings.panel.BLUR && !this._panel_blur.enabled)
                this._panel_blur.enable();
        } catch (e) {
            this._log("Could not enable panel blur directly");
            this._log(e);
        }

        // tells the extension we have enabled the user session components, so that we do not
        // disable them later if they were not even enabled to begin with
        this._user_session_mode_enabled = true;
    }

    /// Disables the extension.
    ///
    /// This extension needs to use the 'unlock-dialog' session mode in order to change the blur on
    /// the lockscreen. We have kind of two states of enablement for this extension:
    /// - the 'enabled' state, which means that we have created the necessary components (which only
    ///   are js objects) and enabled the lockscreen blur (which means swapping two functions from
    ///   the `UnlockDialog` constructor with our ones;
    /// - the 'user session enabled` mode, which means that we are in the 'enabled' mode AND we are
    ///   in the user mode, and so we enable all the other components that we created before.
    /// We switch from one state to the other thanks to `this._on_session_mode_changed`, and we
    /// track wether or not we are in the user mode with `this._user_session_mode_enabled` (because
    /// `this._on_session_mode_changed` might be called multiple times while in the user session
    /// mode, typically when going back from simple lockscreen and not sleep mode).
    disable() {
        this._log("disabling extension...");

        // disable every component from user session mode
        if (this._user_session_mode_enabled)
            this._disable_user_session();

        // disable lockscreen blur too
        this._lockscreen_blur.disable();

        // untrack them
        this._panel_blur = null;
        this._dash_to_dock_blur = null;
        this._overview_blur = null;
        this._appfolder_blur = null;
        this._lockscreen_blur = null;
        this._window_list_blur = null;
        this._applications_blur = null;
        this._screenshot_blur = null;

        // make sure no settings change can re-enable them
        this._settings.disconnect_all_settings();

        // force disconnecting every signal, even if component crashed
        this._connections.forEach((connections) => {
            connections.disconnect_all();
        });
        this._connections = [];

        // remove the clipped redraws flag
        this._reenable_clipped_redraws();

        // remove the extension from GJS's global
        delete global.blur_my_shell;

        this._log("extension disabled.");

        this._settings = null;
    }

    /// Disables the components related to the user session (everything except lockscreen blur).
    _disable_user_session() {
        this._log("disabling user session mode...");

        // disable every component except lockscreen blur
        this._panel_blur.disable();
        this._dash_to_dock_blur.disable();
        this._overview_blur.disable();
        this._appfolder_blur.disable();
        this._window_list_blur.disable();
        this._applications_blur.disable();
        this._screenshot_blur.disable();

        // remove the clipped redraws flag
        this._reenable_clipped_redraws();

        // tells the extension we have disabled the user session components, so that we do not
        // disable them later again if they were already disabled
        this._user_session_mode_enabled = false;
    }

    /// Restarts the components related to the user session.
    _restart() {
        this._log("restarting...");

        this._disable_user_session();
        this._enable_user_session();

        this._log("restarted.");
    }

    /// Changes the extension to operate either on 'user' mode or 'unlock-dialog' mode, switching
    /// from one to the other means enabling/disabling every component except lockscreen blur.
    _on_session_mode_changed(session) {
        if (session.currentMode === 'user' || session.parentMode === 'user') {
            if (!this._user_session_mode_enabled)
                // we need to activate everything
                this._enable_user_session();
        }
        else if (session.currentMode === 'unlock-dialog') {
            if (this._user_session_mode_enabled)
                // we need to disable the components related to the user session mode
                this._disable_user_session();
        }
    }

    /// Add or remove the clutter debug flag to disable clipped redraws.
    /// This will entirely fix the blur effect, but should not be used except if
    /// the user really needs it, as clipped redraws are a huge performance
    /// boost for the compositor.
    _update_clipped_redraws() {
        if (this._settings.HACKS_LEVEL === 3)
            this._disable_clipped_redraws();
        else
            this._reenable_clipped_redraws();
    }

    /// Add the Clutter debug flag.
    _disable_clipped_redraws() {
        Meta.add_clutter_debug_flags(
            null, Clutter.DrawDebugFlag.DISABLE_CLIPPED_REDRAWS, null
        );
    }

    /// Remove the Clutter debug flag.
    _reenable_clipped_redraws() {
        Meta.remove_clutter_debug_flags(
            null, Clutter.DrawDebugFlag.DISABLE_CLIPPED_REDRAWS, null
        );
    }

    /// Enables every component from the user session needed, should be called when the shell is
    /// entirely loaded as the `enable` methods interact with it.
    _enable_components() {
        // enable each component if needed, and if it is not already enabled

        if (this._settings.panel.BLUR && !this._panel_blur.enabled)
            this._panel_blur.enable();

        if (this._settings.dash_to_dock.BLUR && !this._dash_to_dock_blur.enabled)
            this._dash_to_dock_blur.enable();

        if (this._settings.overview.BLUR && !this._overview_blur.enabled)
            this._overview_blur.enable();

        if (this._settings.appfolder.BLUR)
            this._appfolder_blur.enable();

        if (this._settings.applications.BLUR)
            this._applications_blur.enable();

        if (this._settings.window_list.BLUR)
            this._window_list_blur.enable();

        if (this._settings.screenshot.BLUR)
            this._screenshot_blur.enable();

        this._log("all components enabled.");
    }

    /// Updates needed things in each component when a preference changed
    _connect_to_settings() {

        // global blur values changed, update everybody

        this._settings.SIGMA_changed(() => {
            this._update_sigma();
        });
        this._settings.BRIGHTNESS_changed(() => {
            this._update_brightness();
        });
        this._settings.COLOR_changed(() => {
            this._update_color();
        });
        this._settings.NOISE_AMOUNT_changed(() => {
            this._update_noise_amount();
        });
        this._settings.NOISE_LIGHTNESS_changed(() => {
            this._update_noise_lightness();
        });
        this._settings.COLOR_AND_NOISE_changed(() => {
            // both updating noise amount and color calls `update_enabled` on
            // each color and noise effects
            this._update_noise_amount();
            this._update_color();
        });

        // restart the extension when hacks level is changed, easier than
        // restarting individual components and should not happen often either
        this._settings.HACKS_LEVEL_changed(_ => this._restart());

        // connect each component to use the proper sigma/brightness/color
        INDEPENDENT_COMPONENTS.forEach(component => {
            this._connect_to_individual_settings(component);
        });

        // other component's preferences changed

        // ---------- OVERVIEW ----------

        // toggled on/off
        this._settings.overview.BLUR_changed(() => {
            if (this._settings.overview.BLUR)
                this._overview_blur.enable();
            else
                this._overview_blur.disable();
        });

        // overview pipeline changed
        this._settings.overview.PIPELINE_changed(() => {
            if (this._settings.overview.BLUR)
                this._overview_blur.update_backgrounds();
        });

        // overview components style changed
        this._settings.overview.STYLE_COMPONENTS_changed(() => {
            if (this._settings.overview.BLUR)
                this._overview_blur.update_components_classname();
        });


        // ---------- APPFOLDER ----------

        // toggled on/off
        this._settings.appfolder.BLUR_changed(() => {
            if (this._settings.appfolder.BLUR)
                this._appfolder_blur.enable();
            else
                this._appfolder_blur.disable();
        });

        // appfolder dialogs style changed
        this._settings.appfolder.STYLE_DIALOGS_changed(() => {
            if (this._settings.appfolder.BLUR)
                this._appfolder_blur.blur_appfolders();
        });


        // ---------- PANEL ----------

        // toggled on/off
        this._settings.panel.BLUR_changed(() => {
            if (this._settings.panel.BLUR)
                this._panel_blur.enable();
            else
                this._panel_blur.disable();
        });

        // panel pipeline changed
        this._settings.panel.PIPELINE_changed(() => {
            if (this._settings.panel.BLUR)
                this._panel_blur.update_pipeline();
        });

        // static blur toggled on/off, really we can just reload the blur at this point
        this._settings.panel.STATIC_BLUR_changed(() => {
            if (this._settings.panel.BLUR)
                this._panel_blur.reset();
        });

        // panel blur's overview connection toggled on/off
        this._settings.panel.UNBLUR_IN_OVERVIEW_changed(() => {
            this._panel_blur.connect_to_windows_and_overview();
        });

        // force light text toggled on/off
        this._settings.panel.FORCE_LIGHT_TEXT_changed(() => {
            if (this._settings.panel.BLUR)
                this._panel_blur.update_light_text_classname();
        });

        // panel override background toggled on/off
        this._settings.panel.OVERRIDE_BACKGROUND_changed(() => {
            if (this._settings.panel.BLUR)
                this._panel_blur.connect_to_windows_and_overview();
        });

        // panel style changed
        this._settings.panel.STYLE_PANEL_changed(() => {
            if (this._settings.panel.BLUR)
                this._panel_blur.connect_to_windows_and_overview();
        });

        // panel background's dynamic overriding toggled on/off
        this._settings.panel.OVERRIDE_BACKGROUND_DYNAMICALLY_changed(() => {
            if (this._settings.panel.BLUR)
                this._panel_blur.connect_to_windows_and_overview();
        });


        // ---------- DASH TO DOCK ----------

        // toggled on/off
        this._settings.dash_to_dock.BLUR_changed(() => {
            if (this._settings.dash_to_dock.BLUR)
                this._dash_to_dock_blur.enable();
            else
                this._dash_to_dock_blur.disable();
        });

        // static blur toggled on/off
        this._settings.dash_to_dock.STATIC_BLUR_changed(() => {
            if (this._settings.dash_to_dock.BLUR)
                this._dash_to_dock_blur.change_blur_type();
        });

        // dash-to-dock corner radius changed
        this._settings.dash_to_dock.CORNER_RADIUS_changed(() => {
            if (this._settings.dash_to_dock.STATIC_BLUR)
                this._dash_to_dock_blur.set_corner_radius(this._settings.dash_to_dock.CORNER_RADIUS);
        });

        // dash-to-dock override background toggled on/off
        this._settings.dash_to_dock.OVERRIDE_BACKGROUND_changed(() => {
            if (this._settings.dash_to_dock.BLUR)
                this._dash_to_dock_blur.update_background();
        });

        // dash-to-dock style changed
        this._settings.dash_to_dock.STYLE_DASH_TO_DOCK_changed(() => {
            if (this._settings.dash_to_dock.BLUR)
                this._dash_to_dock_blur.update_background();
        });

        // dash-to-dock blur's overview connection toggled on/off
        this._settings.dash_to_dock.UNBLUR_IN_OVERVIEW_changed(() => {
            if (this._settings.dash_to_dock.BLUR)
                this._dash_to_dock_blur.connect_to_overview();
        });


        // ---------- APPLICATIONS ----------

        // toggled on/off
        this._settings.applications.BLUR_changed(() => {
            if (this._settings.applications.BLUR)
                this._applications_blur.enable();
            else
                this._applications_blur.disable();
        });

        // application opacity changed
        this._settings.applications.OPACITY_changed(_ => {
            if (this._settings.applications.BLUR)
                this._applications_blur.set_opacity(
                    this._settings.applications.OPACITY
                );
        });

        // application dynamic-opacity changed
        this._settings.applications.DYNAMIC_OPACITY_changed(_ => {
            if (this._settings.applications.BLUR)
                this._applications_blur.init_dynamic_opacity();
        });

        // application blur-on-overview changed
        this._settings.applications.BLUR_ON_OVERVIEW_changed(_ => {
            if (this._settings.applications.BLUR)
                this._applications_blur.connect_to_overview();
        });

        // application enable-all changed
        this._settings.applications.ENABLE_ALL_changed(_ => {
            if (this._settings.applications.BLUR)
                this._applications_blur.update_all_windows();
        });

        // application whitelist changed
        this._settings.applications.WHITELIST_changed(_ => {
            if (
                this._settings.applications.BLUR
                && !this._settings.applications.ENABLE_ALL
            )
                this._applications_blur.update_all_windows();
        });

        // application blacklist changed
        this._settings.applications.BLACKLIST_changed(_ => {
            if (
                this._settings.applications.BLUR
                && this._settings.applications.ENABLE_ALL
            )
                this._applications_blur.update_all_windows();
        });


        // ---------- LOCKSCREEN ----------

        // toggled on/off
        this._settings.lockscreen.BLUR_changed(() => {
            if (this._settings.lockscreen.BLUR)
                this._lockscreen_blur.enable();
            else
                this._lockscreen_blur.disable();
        });

        // lockscreen pipeline changed
        this._settings.lockscreen.PIPELINE_changed(() => {
            if (this._settings.lockscreen.BLUR)
                this._lockscreen_blur.update_lockscreen();
        });


        // ---------- WINDOW LIST ----------

        // toggled on/off
        this._settings.window_list.BLUR_changed(() => {
            if (this._settings.window_list.BLUR)
                this._window_list_blur.enable();
            else
                this._window_list_blur.disable();
        });


        // ---------- HIDETOPBAR ----------

        // toggled on/off
        this._settings.hidetopbar.COMPATIBILITY_changed(() => {
            // no need to verify if it is enabled or not, it is done anyway
            this._panel_blur.connect_to_windows_and_overview();
        });


        // ---------- DASH TO PANEL ----------

        // toggled on/off
        this._settings.dash_to_panel.BLUR_ORIGINAL_PANEL_changed(() => {
            if (this._settings.panel.BLUR)
                this._panel_blur.reset();
        });


        // ---------- SCREENSHOT ----------

        // toggled on/off
        this._settings.screenshot.BLUR_changed(() => {
            if (this._settings.screenshot.BLUR)
                this._screenshot_blur.enable();
            else
                this._screenshot_blur.disable();
        });

        // screenshot pipeline changed
        this._settings.screenshot.PIPELINE_changed(() => {
            if (this._settings.screenshot.BLUR)
                this._screenshot_blur.update_pipeline();
        });
    }

    /// Select the component by its name and connect it to its preferences
    /// changes for general values, sigma and brightness.
    ///
    /// Doing this in such a way is less accessible but prevents a lot of
    /// boilerplate and headaches.
    _connect_to_individual_settings(name) {
        // get component and preferences needed
        let component = this['_' + name + '_blur'];
        let component_settings = this._settings[name];

        // general values switch is toggled
        component_settings.CUSTOMIZE_changed(() => {
            if (component_settings.CUSTOMIZE) {
                component.set_sigma(component_settings.SIGMA);
                component.set_brightness(component_settings.BRIGHTNESS);
                component.set_color(component_settings.COLOR);
                component.set_noise_amount(component_settings.NOISE_AMOUNT);
                component.set_noise_lightness(component_settings.NOISE_LIGHTNESS);
            }
            else {
                component.set_sigma(this._settings.SIGMA);
                component.set_brightness(this._settings.BRIGHTNESS);
                component.set_color(this._settings.COLOR);
                component.set_noise_amount(this._settings.NOISE_AMOUNT);
                component.set_noise_lightness(this._settings.NOISE_LIGHTNESS);
            }
        });

        // sigma is changed
        component_settings.SIGMA_changed(() => {
            if (component_settings.CUSTOMIZE)
                component.set_sigma(component_settings.SIGMA);
            else
                component.set_sigma(this._settings.SIGMA);
        });

        // brightness is changed
        component_settings.BRIGHTNESS_changed(() => {
            if (component_settings.CUSTOMIZE)
                component.set_brightness(component_settings.BRIGHTNESS);
            else
                component.set_brightness(this._settings.BRIGHTNESS);
        });

        // color is changed
        component_settings.COLOR_changed(() => {
            if (component_settings.CUSTOMIZE)
                component.set_color(component_settings.COLOR);
            else
                component.set_color(this._settings.COLOR);
        });

        // noise amount is changed
        component_settings.NOISE_AMOUNT_changed(() => {
            if (component_settings.CUSTOMIZE)
                component.set_noise_amount(component_settings.NOISE_AMOUNT);
            else
                component.set_noise_amount(this._settings.NOISE_AMOUNT);
        });

        // noise lightness is changed
        component_settings.NOISE_LIGHTNESS_changed(() => {
            if (component_settings.CUSTOMIZE)
                component.set_noise_lightness(component_settings.NOISE_LIGHTNESS);
            else
                component.set_noise_lightness(this._settings.NOISE_LIGHTNESS);
        });
    }

    /// Update each component's sigma value
    _update_sigma() {
        INDEPENDENT_COMPONENTS.forEach(name => {
            // get component and preferences needed
            let component = this['_' + name + '_blur'];
            let component_settings = this._settings[name];

            // update sigma accordingly
            if (component_settings.CUSTOMIZE)
                component.set_sigma(component_settings.SIGMA);
            else
                component.set_sigma(this._settings.SIGMA);
        });
    }

    /// Update each component's brightness value
    _update_brightness() {
        INDEPENDENT_COMPONENTS.forEach(name => {
            // get component and preferences needed
            let component = this['_' + name + '_blur'];
            let component_settings = this._settings[name];

            // update brightness accordingly
            if (component_settings.CUSTOMIZE)
                component.set_brightness(component_settings.BRIGHTNESS);
            else
                component.set_brightness(this._settings.BRIGHTNESS);
        });
    }

    /// Update each component's color value
    _update_color() {
        INDEPENDENT_COMPONENTS.forEach(name => {
            // get component and preferences needed
            let component = this['_' + name + '_blur'];
            let component_settings = this._settings[name];

            // update color accordingly
            if (component_settings.CUSTOMIZE)
                component.set_color(component_settings.COLOR);
            else
                component.set_color(this._settings.COLOR);
        });
    }

    /// Update each component's noise amount value
    _update_noise_amount() {
        INDEPENDENT_COMPONENTS.forEach(name => {
            // get component and preferences needed
            let component = this['_' + name + '_blur'];
            let component_settings = this._settings[name];

            // update color accordingly
            if (component_settings.CUSTOMIZE)
                component.set_noise_amount(component_settings.NOISE_AMOUNT);
            else
                component.set_noise_amount(this._settings.NOISE_AMOUNT);
        });
    }

    /// Update each component's noise lightness value
    _update_noise_lightness() {
        INDEPENDENT_COMPONENTS.forEach(name => {
            // get component and preferences needed
            let component = this['_' + name + '_blur'];
            let component_settings = this._settings[name];

            // update color accordingly
            if (component_settings.CUSTOMIZE)
                component.set_noise_lightness(component_settings.NOISE_LIGHTNESS);
            else
                component.set_noise_lightness(this._settings.NOISE_LIGHTNESS);
        });
    }

    _log(str) {
        if (this._settings.DEBUG)
            console.log(`[Blur my Shell > extension]    ${str}`);
    }
}
