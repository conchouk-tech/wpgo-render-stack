<?php
/**
 * WPGo 4.5 RC3 generic-MCP media abilities.
 *
 * The 4.4.x core already has hardened REST handlers for remote-media and
 * device-upload sessions. This adapter exposes those existing handlers through
 * WordPress Abilities so Claude, Gemini, ChatGPT and other MCP clients receive
 * the same capability surface.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WPGo_Media_Abilities_RC3 {
	const VERSION = '4.5.0-rc.3';

	public static function boot() {
		add_action( 'wp_abilities_api_init', array( __CLASS__, 'register' ), 96 );
	}

	public static function can_upload() {
		return current_user_can( 'upload_files' );
	}

	public static function register() {
		if ( ! function_exists( 'wp_register_ability' ) || ! class_exists( 'WPGo_Media' ) ) {
			return;
		}

		self::register_ability(
			'wpgo/upload-media-from-url',
			'Upload media from public HTTPS URL',
			'Approval-gated media upload using WPGo\'s existing public-network validation, 20 MB limit and WordPress media sideload pipeline.',
			array(
				'type' => 'object',
				'properties' => array(
					'url'      => array( 'type' => 'string', 'format' => 'uri', 'pattern' => '^https://' ),
					'title'    => array( 'type' => 'string', 'maxLength' => 500 ),
					'alt_text' => array( 'type' => 'string', 'maxLength' => 1000 ),
					'post_id'  => array( 'type' => 'integer', 'minimum' => 0 ),
				),
				'required' => array( 'url' ),
				'additionalProperties' => false,
			),
			array( __CLASS__, 'upload_from_url' ),
			false,
			false,
			false
		);

		self::register_ability(
			'wpgo/request-media-upload',
			'Create local-device media upload session',
			'Creates a short-lived WordPress upload page so the user can choose local files without exposing the AI client to the files themselves.',
			array( 'type' => 'object', 'additionalProperties' => false ),
			array( __CLASS__, 'request_device_upload' ),
			false,
			false,
			false
		);

		self::register_ability(
			'wpgo/check-media-upload',
			'Check local-device media upload session',
			'Reads a WPGo upload session and returns media IDs and WordPress URLs for files the user uploaded.',
			array(
				'type' => 'object',
				'properties' => array(
					'upload_id' => array( 'type' => 'string', 'minLength' => 8, 'maxLength' => 100 ),
				),
				'required' => array( 'upload_id' ),
				'additionalProperties' => false,
			),
			array( __CLASS__, 'check_device_upload' ),
			true,
			false,
			true
		);
	}

	private static function register_ability( $name, $label, $description, $schema, $callback, $readonly, $destructive, $idempotent ) {
		if ( function_exists( 'wp_has_ability' ) && wp_has_ability( $name ) ) {
			return;
		}
		wp_register_ability(
			$name,
			array(
				'label'               => $label,
				'description'         => $description,
				'category'            => 'wpgo',
				'input_schema'        => $schema,
				'execute_callback'    => $callback,
				'permission_callback' => array( __CLASS__, 'can_upload' ),
				'meta'                => array(
					'show_in_rest' => true,
					'annotations'  => array(
						'readonly'    => (bool) $readonly,
						'destructive' => (bool) $destructive,
						'idempotent'  => (bool) $idempotent,
					),
				),
			)
		);
	}

	/**
	 * Public preflight helper used by the RC3 approval proxy. It deliberately
	 * mirrors the existing core route's public-network policy so obviously bad
	 * requests never create an approval.
	 */
	public static function preflight_remote_url( $raw_url ) {
		$url = esc_url_raw( (string) $raw_url );
		if ( ! $url || 0 !== stripos( $url, 'https://' ) || ! wp_http_validate_url( $url ) ) {
			return new WP_Error( 'wpgo_invalid_media_url', 'Only valid public HTTPS media URLs are allowed.', array( 'status' => 400, 'preflight' => true, 'approval_created' => false ) );
		}
		$host = wp_parse_url( $url, PHP_URL_HOST );
		if ( ! $host || 'localhost' === strtolower( $host ) ) {
			return new WP_Error( 'wpgo_invalid_media_host', 'Local/private media hosts are not allowed.', array( 'status' => 400, 'preflight' => true, 'approval_created' => false ) );
		}
		$ips = @gethostbynamel( $host );
		if ( is_array( $ips ) ) {
			foreach ( $ips as $ip ) {
				if ( false === filter_var( $ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE ) ) {
					return new WP_Error( 'wpgo_private_media_host', 'Media URL resolves to a private or reserved network.', array( 'status' => 400, 'preflight' => true, 'approval_created' => false ) );
				}
			}
		}
		return $url;
	}

	public static function upload_from_url( $input ) {
		$input = is_array( $input ) ? $input : array();
		$preflight = self::preflight_remote_url( $input['url'] ?? '' );
		if ( is_wp_error( $preflight ) ) {
			return $preflight;
		}
		$request = new WP_REST_Request( 'POST', '/wpgo/v1/media/from-url' );
		$request->set_param( 'url', $preflight );
		$request->set_param( 'title', (string) ( $input['title'] ?? '' ) );
		$request->set_param( 'alt_text', (string) ( $input['alt_text'] ?? '' ) );
		$request->set_param( 'post_id', absint( $input['post_id'] ?? 0 ) );
		$response = WPGo_Media::from_url( $request );
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		if ( $response instanceof WP_REST_Response ) {
			return $response->get_data();
		}
		return $response;
	}

	public static function request_device_upload() {
		$response = WPGo_Media::create_upload_session();
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		return $response instanceof WP_REST_Response ? $response->get_data() : $response;
	}

	public static function check_device_upload( $input ) {
		$input = is_array( $input ) ? $input : array();
		$request = new WP_REST_Request( 'GET', '/wpgo/v1/media/upload-session/' . rawurlencode( (string) ( $input['upload_id'] ?? '' ) ) );
		$request->set_param( 'id', sanitize_text_field( (string) ( $input['upload_id'] ?? '' ) ) );
		$response = WPGo_Media::upload_session_status( $request );
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		return $response instanceof WP_REST_Response ? $response->get_data() : $response;
	}
}

WPGo_Media_Abilities_RC3::boot();
