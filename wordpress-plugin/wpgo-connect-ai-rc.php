<?php
/**
 * Plugin Name: WPGo Connect AI - 4.5 RC Module
 * Plugin URI: https://wpgo.vivaforte.es/
 * Description: Release-candidate WordPress-first AI connection experience for WPGo. Designed to run alongside the current WPGo core while 4.5 is validated.
 * Version: 4.5.0-rc.2
 * Requires at least: 6.9
 * Requires PHP: 8.0
 * Author: WPGo
 * Text Domain: wpgo
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'WPGO_CONNECT_AI_RC_VERSION', '4.5.0-rc.2' );
define( 'WPGO_CONNECT_AI_RC_GATEWAY', 'https://wpgo-mcp-rc.onrender.com' );

/*
 * The temporary RC companion is deliberately pinned to the isolated RC
 * gateway. The production WPGo core continues to use the production gateway.
 */
add_filter(
	'wpgo_mcp_gateway_base',
	static function ( $gateway ) {
		return WPGO_CONNECT_AI_RC_GATEWAY;
	},
	999
);

add_action(
	'plugins_loaded',
	static function () {
		$module = __DIR__ . '/includes/class-wpgo-connect-ai.php';
		if ( is_readable( $module ) ) {
			require_once $module;
		}
	},
	20
);
