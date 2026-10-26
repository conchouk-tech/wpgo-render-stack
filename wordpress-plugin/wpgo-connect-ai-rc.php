<?php
/**
 * Plugin Name: WPGo Connect AI - 4.5 RC Module
 * Plugin URI: https://wpgo.vivaforte.es/
 * Description: Release-candidate WordPress-first AI connection and agent-experience layer for WPGo. Runs alongside the current WPGo core while 4.5 is validated.
 * Version: 4.5.0-rc.3
 * Requires at least: 6.9
 * Requires PHP: 8.0
 * Author: WPGo
 * Text Domain: wpgo
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'WPGO_CONNECT_AI_RC_VERSION', '4.5.0-rc.3' );
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
		$connect = __DIR__ . '/includes/class-wpgo-connect-ai.php';
		if ( is_readable( $connect ) ) {
			require_once $connect;
		}
		$agent_experience = __DIR__ . '/includes/class-wpgo-agent-experience.php';
		if ( is_readable( $agent_experience ) ) {
			require_once $agent_experience;
		}
	},
	20
);
