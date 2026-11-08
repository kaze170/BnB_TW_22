/**
 * Text rendering — now backed by the ORIGINAL FxFont (.fft) bitmap font.
 * See ui/font.ts for the decoder (port of CFontMan sub_676700). This module
 * re-exports the faithful renderer so existing UI code keeps its API.
 */
export { textSprite, measureText, loadFonts, fontsReady, type TextStyle } from "./font.ts";
