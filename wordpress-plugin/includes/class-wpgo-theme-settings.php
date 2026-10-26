<?php
/**
 * WPGo 4.5 RC3 safe theme-setting adapter.
 *
 * This is intentionally narrow. It exposes only settings we have inspected in
 * the active theme source and writes through WordPress theme mods rather than
 * allowing arbitrary option/customizer mutation.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WPGo_Theme_Settings_RC3 {
	const VERSION = '4.5.0-rc.3';

	public static function boot() {
		add_action( 'wp_abilities_api_init', array( __CLASS__, 'register_abilities' ), 95 );
	}

	private static function supported_theme() {
		$stylesheet = sanitize_key( get_stylesheet() );
		$template   = sanitize_key( get_template() );
		if ( 'kadence' === $stylesheet || 'kadence' === $template ) {
			return 'kadence';
		}
		if ( 'astra' === $stylesheet || 'astra' === $template ) {
			return 'astra';
		}
		if ( 'generatepress' === $stylesheet || 'generatepress' === $template ) {
			return 'generatepress';
		}
		return '';
	}

	private static function catalog_for( $theme ) {
		if ( 'kadence' === $theme ) {
			return array(
				'footer_html_content' => array(
					'label'       => 'Footer HTML content',
					'type'        => 'string',
					'max_length'  => 5000,
					'description' => 'Kadence footer HTML/copyright content. Supports Kadence placeholders such as {copyright}, {year}, {site-title} and {theme-credit}.',
				),
				'footer_html_link_style' => array(
					'label'       => 'Footer link style',
					'type'        => 'enum',
					'values'      => array( 'normal', 'plain' ),
					'description' => 'Kadence footer HTML link underline style.',
				),
			);
		}
		// Catalog placeholders make support explicit without pretending arbitrary
		// Astra/GeneratePress settings are safe before their source adapters ship.
		return array();
	}

	public static function can_read() {
		return current_user_can( 'edit_theme_options' ) || current_user_can( 'manage_options' );
	}

	public static function can_write() {
		return current_user_can( 'edit_theme_options' ) && current_user_can( 'manage_options' );
	}

	public static function register_abilities() {
		if ( ! function_exists( 'wp_register_ability' ) ) {
			return;
		}
		wp_register_ability(
			'wpgo/theme-settings-catalog',
			array(
				'label'               => 'Safe theme settings catalog',
				'description'         => 'Lists the active theme settings WPGo can safely read or change without editing theme files or arbitrary options.',
				'category'            => 'wpgo',
				'input_schema'        => array( 'type' => 'object', 'additionalProperties' => false ),
				'output_schema'       => array( 'type' => 'object', 'additionalProperties' => true ),
				'execute_callback'    => array( __CLASS__, 'catalog' ),
				'permission_callback' => array( __CLASS__, 'can_read' ),
				'meta'                => array( 'show_in_rest' => true, 'annotations' => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ) ),
			)
		);
		wp_register_ability(
			'wpgo/theme-setting-update',
			array(
				'label'       => 'Update safe theme setting',
				'description' => 'Approval-gated update of one explicitly allowlisted active-theme setting. Arbitrary Customizer/options writes are refused.',
				'category'    => 'wpgo',
				'input_schema' => array(
					'type' => 'object',
					'properties' => array(
						'setting' => array( 'type' => 'string', 'enum' => array( 'footer_html_content', 'footer_html_link_style' ) ),
						'value'   => (object) array(),
					),
					'required' => array( 'setting', 'value' ),
					'additionalProperties' => false,
				),
				'output_schema'       => array( 'type' => 'object', 'additionalProperties' => true ),
				'execute_callback'    => array( __CLASS__, 'update' ),
				'permission_callback' => array( __CLASS__, 'can_write' ),
				'meta'                => array( 'show_in_rest' => true, 'annotations' => array( 'readonly' => false, 'destructive' => false, 'idempotent' => true ) ),
			)
		);
	}

	public static function catalog() {
		$theme   = self::supported_theme();
		$catalog = self::catalog_for( $theme );
		$current = array();
		foreach ( array_keys( $catalog ) as $setting ) {
			$current[ $setting ] = get_theme_mod( $setting, null );
		}
		return array(
			'version'         => self::VERSION,
			'theme'           => $theme ?: sanitize_key( get_stylesheet() ),
			'supported'       => ! empty( $catalog ),
			'settings'        => $catalog,
			'current_values'  => $current,
			'arbitrary_write' => false,
		);
	}

	public static function update( $input ) {
		$theme = self::supported_theme();
		$catalog = self::catalog_for( $theme );
		if ( ! $catalog ) {
			return new WP_Error( 'wpgo_theme_settings_unsupported', 'WPGo does not yet have a reviewed safe-settings adapter for this active theme.', array( 'status' => 409 ) );
		}
		$setting = sanitize_key( (string) ( $input['setting'] ?? '' ) );
		if ( ! isset( $catalog[ $setting ] ) ) {
			return new WP_Error( 'wpgo_theme_setting_not_allowlisted', 'This theme setting is not on WPGo\'s reviewed allowlist.', array( 'status' => 400, 'valid_settings' => array_keys( $catalog ) ) );
		}
		$definition = $catalog[ $setting ];
		$value = $input['value'] ?? null;
		if ( 'footer_html_content' === $setting ) {
			if ( ! is_string( $value ) || strlen( $value ) > (int) $definition['max_length'] ) {
				return new WP_Error( 'wpgo_theme_setting_value', 'Footer content must be a string within the 5000-byte limit.', array( 'status' => 400 ) );
			}
			$value = wp_kses_post( $value );
		} elseif ( 'footer_html_link_style' === $setting ) {
			$value = sanitize_key( (string) $value );
			if ( ! in_array( $value, $definition['values'], true ) ) {
				return new WP_Error( 'wpgo_theme_setting_value', 'Unsupported footer link style.', array( 'status' => 400, 'valid_values' => $definition['values'] ) );
			}
		}
		$before = get_theme_mod( $setting, null );
		set_theme_mod( $setting, $value );
		$after = get_theme_mod( $setting, null );
		if ( $after !== $value ) {
			return new WP_Error( 'wpgo_theme_setting_save_failed', 'WordPress did not persist the reviewed theme setting.', array( 'status' => 500 ) );
		}
		if ( class_exists( 'WPGo_Audit' ) ) {
			WPGo_Audit::log( 'theme_setting_update', array( 'theme' => $theme, 'setting' => $setting ) );
		}
		return array(
			'changed' => $before !== $after,
			'theme'   => $theme,
			'setting' => $setting,
			'before'  => $before,
			'after'   => $after,
		);
	}
}

WPGo_Theme_Settings_RC3::boot();
