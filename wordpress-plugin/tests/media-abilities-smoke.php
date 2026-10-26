<?php
// Standalone RC3 regression for generic-MCP media URL preflight.
define( 'ABSPATH', __DIR__ . '/' );

function add_action() {}
function esc_url_raw( $value ) { return filter_var( (string) $value, FILTER_SANITIZE_URL ); }
function wp_http_validate_url( $value ) { return (bool) filter_var( (string) $value, FILTER_VALIDATE_URL ); }
function wp_parse_url( $value, $component = -1 ) { return parse_url( $value, $component ); }

class WP_Error {
	public $code;
	public $message;
	public $data;
	public function __construct( $code, $message, $data = array() ) {
		$this->code = $code;
		$this->message = $message;
		$this->data = $data;
	}
}
function is_wp_error( $value ) { return $value instanceof WP_Error; }

require_once dirname( __DIR__ ) . '/includes/class-wpgo-media-abilities.php';

$http = WPGo_Media_Abilities_RC3::preflight_remote_url( 'http://example.com/image.jpg' );
if ( ! is_wp_error( $http ) || 'wpgo_invalid_media_url' !== $http->code ) {
	fwrite( STDERR, "HTTP media URL was not rejected before approval.\n" );
	exit( 1 );
}

$localhost = WPGo_Media_Abilities_RC3::preflight_remote_url( 'https://localhost/image.jpg' );
if ( ! is_wp_error( $localhost ) || 'wpgo_invalid_media_host' !== $localhost->code ) {
	fwrite( STDERR, "Localhost media URL was not rejected before approval.\n" );
	exit( 1 );
}

$data = $localhost->data;
if ( empty( $data['preflight'] ) || ! array_key_exists( 'approval_created', $data ) || false !== $data['approval_created'] ) {
	fwrite( STDERR, "Media preflight error did not explicitly prove no approval was created.\n" );
	exit( 1 );
}

fwrite( STDOUT, "WPGo RC3 media URL preflight regression passed.\n" );
