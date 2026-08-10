/**
 * pi-edit-guard — entry point.
 *
 * Pi loads this file via jiti (no build step). The composition root lives
 * in `src/extension.ts`; this file is a thin re-export so Pi's loader
 * doesn't need to know about the `src/` layout.
 *
 * Public API: only the default export. Internal modules are not re-exported
 * to keep the surface minimal.
 */

export { default } from './src/extension.ts';
