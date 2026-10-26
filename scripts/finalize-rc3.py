from pathlib import Path


def replace_once(text, old, new):
    return text.replace(old, new, 1) if old in text else text


gateway = Path('mcp-gateway/server-rc.js')
text = gateway.read_text()
text = text.replace("const VERSION = '1.4.1-rc.2';", "const VERSION = '1.4.2-rc.3';")
text = text.replace("const PRODUCT_VERSION = '4.5.0-rc.2';", "const PRODUCT_VERSION = '4.5.0-rc.3';")
text = replace_once(text, "    connection_history: true\n", "    connection_history: true,\n    agent_preflight: true,\n    schema_guard: true\n")
gateway.write_text(text)

renderer = Path('renderer/server.js')
text = renderer.read_text()
text = text.replace("const VERSION = '4.4.0-rc.2';", "const VERSION = '4.4.1-rc.3';")
concurrency = "const maxConcurrency = Math.max(1, Math.min(12, Number(process.env.WPGO_RENDER_MAX_CONCURRENCY || 3)));\n"
viewports = """const maxConcurrency = Math.max(1, Math.min(12, Number(process.env.WPGO_RENDER_MAX_CONCURRENCY || 3)));
const VIEWPORTS = Object.freeze({
  desktop: { width: 1440, height: 900, isMobile: false, hasTouch: false },
  tablet: { width: 820, height: 1180, isMobile: false, hasTouch: true },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true }
});
"""
if concurrency in text and 'const VIEWPORTS = Object.freeze' not in text:
    text = replace_once(text, concurrency, viewports)
if "    site_audit: true,\n" in text and 'viewport_presets:' not in text:
    text = replace_once(text, "    site_audit: true,\n", "    site_audit: true,\n    viewport_presets: Object.keys(VIEWPORTS),\n")
audit_input = "  const fullPage = req.body?.full_page === true;\n"
if audit_input in text and 'const viewportName =' not in text:
    text = replace_once(text, audit_input, audit_input + "  const viewportName = ['desktop', 'tablet', 'mobile'].includes(String(req.body?.viewport || 'desktop')) ? String(req.body?.viewport || 'desktop') : 'desktop';\n  const viewport = VIEWPORTS[viewportName];\n")
text = replace_once(text, "      viewport: { width: 1365, height: 768 }\n", "      viewport: { width: viewport.width, height: viewport.height },\n      isMobile: viewport.isMobile,\n      hasTouch: viewport.hasTouch\n")
result = "      ok: true, request_id: requestId, final_url: finalUrl, http_status: response?.status() || 0,\n"
if result in text and 'viewport: viewportName' not in text:
    text = replace_once(text, result, result + "      viewport: viewportName, viewport_size: { width: viewport.width, height: viewport.height },\n")
renderer.write_text(text)

renderer_package = Path('renderer/package.json')
renderer_package.write_text(renderer_package.read_text().replace('"version": "4.4.0-rc.2"', '"version": "4.4.1-rc.3"'))

connect = Path('wordpress-plugin/includes/class-wpgo-connect-ai.php')
connect.write_text(connect.read_text().replace("const VERSION = '4.5.0-rc.2';", "const VERSION = '4.5.0-rc.3';"))

agent = Path('wordpress-plugin/includes/class-wpgo-agent-experience.php')
text = agent.read_text()
anchor = "\t\t$manifest = self::manifest();\n\t\t$input    = is_array( $input ) ? $input : array();\n"
media = """\t\t$manifest = self::manifest();
\t\t$input    = is_array( $input ) ? $input : array();

\t\tif ( 'wpgo/upload-media-from-url' === $name && class_exists( 'WPGo_Media_Abilities_RC3' ) ) {
\t\t\treturn WPGo_Media_Abilities_RC3::preflight_remote_url( $input['url'] ?? '' );
\t\t}
"""
if anchor in text and "'wpgo/upload-media-from-url' === $name" not in text:
    text = replace_once(text, anchor, media)
label_anchor = "\t\t\t'wpgo/structured-builder-batch-edit'     => 'Apply a structured builder edit plan',\n"
label_extra = "\t\t\t'wpgo/upload-media-from-url'             => 'Upload one media file from a validated public HTTPS URL',\n\t\t\t'wpgo/request-media-upload'              => 'Create a short-lived local-device media upload session',\n\t\t\t'wpgo/theme-setting-update'              => 'Update one reviewed safe theme setting',\n"
if label_anchor in text and "'wpgo/upload-media-from-url'             =>" not in text:
    text = replace_once(text, label_anchor, label_anchor + label_extra)
agent.write_text(text)

ci = Path('.github/workflows/commercial-hardening.yml')
text = ci.read_text().replace('1.4.1-rc.2', '1.4.2-rc.3').replace('4.5.0-rc.2', '4.5.0-rc.3').replace('RC2', 'RC3')
text = text.replace(
    "if (!health.wordpress_first_onboarding || !health.site_specific_mcp_urls || !health.approval_proxy || !health.connection_history) {",
    "if (!health.wordpress_first_onboarding || !health.site_specific_mcp_urls || !health.approval_proxy || !health.connection_history || !health.agent_preflight || !health.schema_guard) {"
)
lint_marker = "          php -l wordpress-plugin/includes/class-wpgo-connect-ai.php\n"
lint_extra = "          php -l wordpress-plugin/includes/class-wpgo-agent-experience.php\n          php -l wordpress-plugin/includes/class-wpgo-theme-settings.php\n          php -l wordpress-plugin/includes/class-wpgo-media-abilities.php\n          php wordpress-plugin/tests/agent-experience-smoke.php\n          php wordpress-plugin/tests/media-abilities-smoke.php\n"
if lint_marker in text and 'media-abilities-smoke.php' not in text:
    text = replace_once(text, lint_marker, lint_marker + lint_extra)
package_dir = '/tmp/wpgo-connect-ai-4.5.0-rc.3/wpgo-connect-ai/includes/'
copy_marker = f"          cp wordpress-plugin/includes/class-wpgo-connect-ai.php {package_dir}\n"
copy_extra = f"          cp wordpress-plugin/includes/class-wpgo-agent-experience.php {package_dir}\n          cp wordpress-plugin/includes/class-wpgo-theme-settings.php {package_dir}\n          cp wordpress-plugin/includes/class-wpgo-media-abilities.php {package_dir}\n"
if copy_marker in text and 'class-wpgo-media-abilities.php /tmp/' not in text:
    text = replace_once(text, copy_marker, copy_marker + copy_extra)
ci.write_text(text)

print('WPGo RC3 source finalization complete')
