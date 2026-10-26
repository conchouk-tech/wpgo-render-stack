<?php
/**
 * WPGo 4.5 Connect AI admin module.
 *
 * This file is intentionally self-contained so it can be folded into the
 * commercial WPGo plugin without changing the existing abilities/runtime code.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WPGo_Connect_AI {
	const VERSION = '4.5.0-rc.2';
	const DEFAULT_GATEWAY = 'https://wpgo-mcp-ga.onrender.com';
	const PAGE_SLUG = 'wpgo-connect-ai';

	/** @var self|null */
	private static $instance = null;

	/** @var array|null */
	private $connection = null;

	public static function boot() {
		if ( null === self::$instance ) {
			self::$instance = new self();
		}
		return self::$instance;
	}

	private function __construct() {
		add_action( 'admin_menu', array( $this, 'register_menu' ), 40 );
		add_action( 'admin_post_wpgo_refresh_connect_ai', array( $this, 'refresh_connection' ) );
		add_action( 'admin_notices', array( $this, 'maybe_show_recovery_email_notice' ) );
	}

	private function parent_menu_slug() {
		$preferred = apply_filters( 'wpgo_connect_ai_parent_slug', '' );
		if ( ! empty( $preferred ) ) {
			return $preferred;
		}
		global $menu;
		foreach ( (array) $menu as $item ) {
			$slug = isset( $item[2] ) ? (string) $item[2] : '';
			if ( in_array( $slug, array( 'wpgo', 'wpgo-dashboard', 'wpgo-settings' ), true ) ) {
				return $slug;
			}
		}
		return 'tools.php';
	}

	private function page_url() {
		$parent = $this->parent_menu_slug();
		return 'tools.php' === $parent ? admin_url( 'tools.php?page=' . self::PAGE_SLUG ) : admin_url( 'admin.php?page=' . self::PAGE_SLUG );
	}

	public function register_menu() {
		$parent = $this->parent_menu_slug();
		if ( 'tools.php' === $parent ) {
			add_management_page(
				__( 'Connect AI', 'wpgo' ),
				__( 'WPGo Connect AI', 'wpgo' ),
				'manage_options',
				self::PAGE_SLUG,
				array( $this, 'render_page' )
			);
			return;
		}

		add_submenu_page(
			$parent,
			__( 'Connect AI', 'wpgo' ),
			__( 'Connect AI', 'wpgo' ),
			'manage_options',
			self::PAGE_SLUG,
			array( $this, 'render_page' )
		);
	}

	private function gateway_base() {
		$base = (string) apply_filters( 'wpgo_mcp_gateway_base', self::DEFAULT_GATEWAY );
		$base = untrailingslashit( esc_url_raw( $base ) );
		return $base;
	}

	private function site_url() {
		return trailingslashit( home_url( '/' ) );
	}

	private function request_connection() {
		if ( is_array( $this->connection ) ) {
			return $this->connection;
		}

		$gateway = $this->gateway_base();
		if ( empty( $gateway ) ) {
			return $this->connection = array(
				'ok'      => false,
				'error'   => 'gateway_not_configured',
				'message' => __( 'The WPGo MCP gateway is not configured.', 'wpgo' ),
			);
		}

		$url = add_query_arg(
			array( 'site' => $this->site_url() ),
			$gateway . '/v1/connect/site-link'
		);
		$response = wp_remote_get(
			$url,
			array(
				'timeout'     => 12,
				'redirection' => 0,
				'headers'     => array(
					'Accept'     => 'application/json',
					'User-Agent' => 'WPGo-WordPress/' . self::VERSION,
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			return $this->connection = array(
				'ok'      => false,
				'error'   => 'gateway_unreachable',
				'message' => $response->get_error_message(),
			);
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$body   = json_decode( wp_remote_retrieve_body( $response ), true );
		if ( ! is_array( $body ) ) {
			$body = array();
		}
		if ( $status < 200 || $status >= 300 || empty( $body['ok'] ) ) {
			return $this->connection = array(
				'ok'         => false,
				'error'      => sanitize_key( isset( $body['code'] ) ? $body['code'] : ( isset( $body['error'] ) ? $body['error'] : 'gateway_error' ) ),
				'message'    => sanitize_text_field( isset( $body['message'] ) ? $body['message'] : __( 'WPGo could not prepare this site for an AI connection.', 'wpgo' ) ),
				'request_id' => sanitize_text_field( isset( $body['request_id'] ) ? $body['request_id'] : '' ),
				'status'     => $status,
			);
		}

		$status_url = esc_url_raw( isset( $body['status_url'] ) ? $body['status_url'] : '' );
		$ai_status  = array( 'status' => 'not_connected', 'connected' => false );
		if ( ! empty( $status_url ) ) {
			$status_response = wp_remote_get( $status_url, array( 'timeout' => 8, 'redirection' => 0, 'headers' => array( 'Accept' => 'application/json', 'User-Agent' => 'WPGo-WordPress/' . self::VERSION ) ) );
			if ( ! is_wp_error( $status_response ) && 200 === (int) wp_remote_retrieve_response_code( $status_response ) ) {
				$status_body = json_decode( wp_remote_retrieve_body( $status_response ), true );
				if ( is_array( $status_body ) ) {
					$ai_status = array(
						'status'          => sanitize_key( isset( $status_body['status'] ) ? $status_body['status'] : 'not_connected' ),
						'connected'       => ! empty( $status_body['connected'] ),
						'client_name'     => sanitize_text_field( isset( $status_body['client_name'] ) ? $status_body['client_name'] : '' ),
						'connected_at'    => sanitize_text_field( isset( $status_body['connected_at'] ) ? $status_body['connected_at'] : '' ),
						'last_refresh_at' => sanitize_text_field( isset( $status_body['last_refresh_at'] ) ? $status_body['last_refresh_at'] : '' ),
						'last_seen_at'       => sanitize_text_field( isset( $status_body['last_seen_at'] ) ? $status_body['last_seen_at'] : '' ),
						'refresh_expires_at' => sanitize_text_field( isset( $status_body['refresh_expires_at'] ) ? $status_body['refresh_expires_at'] : '' ),
						'events'             => isset( $status_body['events'] ) && is_array( $status_body['events'] ) ? array_slice( $status_body['events'], 0, 8 ) : array(),
					);
				}
			}
		}

		return $this->connection = array(
			'ok'              => true,
			'mcp_url'         => esc_url_raw( isset( $body['mcp_url'] ) ? $body['mcp_url'] : '' ),
			'status_url'      => $status_url,
			'ai_status'       => $ai_status,
			'connection_page' => esc_url_raw( isset( $body['connection_page'] ) ? $body['connection_page'] : '' ),
			'site_name'       => sanitize_text_field( isset( $body['site_name'] ) ? $body['site_name'] : get_bloginfo( 'name' ) ),
			'request_id'      => sanitize_text_field( isset( $body['request_id'] ) ? $body['request_id'] : '' ),
		);
	}

	public function refresh_connection() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to manage WPGo.', 'wpgo' ) );
		}
		check_admin_referer( 'wpgo_refresh_connect_ai' );
		delete_transient( 'wpgo_connect_ai_status_' . get_current_blog_id() );
		wp_safe_redirect( add_query_arg( 'refreshed', '1', $this->page_url() ) );
		exit;
	}

	private function admin_email_needs_attention() {
		$email = sanitize_email( get_option( 'admin_email' ) );
		if ( empty( $email ) || ! is_email( $email ) ) {
			return true;
		}
		$host = wp_parse_url( home_url( '/' ), PHP_URL_HOST );
		$host = strtolower( preg_replace( '/^www\./', '', (string) $host ) );
		$parts = explode( '@', strtolower( $email ) );
		if ( 2 !== count( $parts ) ) {
			return true;
		}
		return 'admin' === $parts[0] && $host === preg_replace( '/^www\./', '', $parts[1] );
	}

	public function maybe_show_recovery_email_notice() {
		if ( ! current_user_can( 'manage_options' ) || ! $this->admin_email_needs_attention() ) {
			return;
		}
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		if ( ! $screen || false === strpos( (string) $screen->id, self::PAGE_SLUG ) ) {
			return;
		}
		$email = sanitize_email( get_option( 'admin_email' ) );
		printf(
			'<div class="notice notice-warning"><p><strong>%1$s</strong> %2$s <code>%3$s</code>. <a href="%4$s">%5$s</a></p></div>',
			esc_html__( 'Check your WordPress recovery email.', 'wpgo' ),
			esc_html__( 'This site uses an administrator-style address that may not be a real mailbox:', 'wpgo' ),
			esc_html( $email ),
			esc_url( admin_url( 'options-general.php' ) ),
			esc_html__( 'Verify it in Settings → General', 'wpgo' )
		);
	}

	private function styles() {
		return '<style>
		.wpgo-connect-wrap{max-width:1050px;margin-top:24px}.wpgo-connect-hero{background:linear-gradient(135deg,#071016,#102b37);color:#fff;padding:28px;border-radius:16px;border:1px solid #21414e}.wpgo-connect-hero h1{color:#fff;margin:0 0 8px;font-size:30px}.wpgo-connect-hero p{color:#bdcbd2;font-size:15px;max-width:760px}.wpgo-steps{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:22px 0}.wpgo-step{background:#0e222b;color:#b7c7ce;padding:10px;border-radius:9px;text-align:center;font-size:12px}.wpgo-step.on{background:#76e6bc;color:#062017;font-weight:700}.wpgo-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-top:18px}.wpgo-card{background:#fff;border:1px solid #d9e1e5;border-radius:14px;padding:20px}.wpgo-card h2{margin-top:0}.wpgo-url{background:#f5f7f8;border:1px solid #d9e1e5;border-radius:9px;padding:12px;word-break:break-all;font-family:monospace;font-size:12px}.wpgo-ok{color:#0b7a55}.wpgo-bad{color:#b32d2e}.wpgo-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}.wpgo-note{color:#5d6970;font-size:13px}.wpgo-status{margin-top:16px;padding:14px;border-radius:10px;background:#f6f8f9;border:1px solid #dbe2e6}@media(max-width:850px){.wpgo-grid{grid-template-columns:1fr}.wpgo-steps{grid-template-columns:1fr 1fr}}
		</style>';
	}

	public function render_page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$connection = $this->request_connection();
		$site_name  = get_bloginfo( 'name' );
		echo '<div class="wrap wpgo-connect-wrap">';
		echo $this->styles(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		echo '<section class="wpgo-connect-hero">';
		echo '<h1>' . esc_html__( 'Connect AI to this WordPress site', 'wpgo' ) . '</h1>';
		echo '<p>' . esc_html__( 'WPGo identifies this site automatically. You should not have to type the WordPress address or create OAuth credentials by hand.', 'wpgo' ) . '</p>';
		echo '<div class="wpgo-steps"><div class="wpgo-step on">1. WordPress ready</div><div class="wpgo-step">2. Add connector</div><div class="wpgo-step">3. Approve access</div><div class="wpgo-step">4. Connected</div></div>';
		echo '</section>';

		if ( empty( $connection['ok'] ) ) {
			echo '<div class="notice notice-error inline"><p><strong>' . esc_html__( 'WPGo could not prepare the AI connection.', 'wpgo' ) . '</strong> ' . esc_html( isset( $connection['message'] ) ? $connection['message'] : '' ) . '</p>';
			if ( ! empty( $connection['request_id'] ) ) {
				echo '<p>' . esc_html__( 'Request ID:', 'wpgo' ) . ' <code>' . esc_html( $connection['request_id'] ) . '</code></p>';
			}
			echo '</div>';
			$this->render_refresh_button();
			echo '</div>';
			return;
		}

		$mcp_url   = $connection['mcp_url'];
		$ai_status = isset( $connection['ai_status'] ) && is_array( $connection['ai_status'] ) ? $connection['ai_status'] : array();
		if ( ! empty( $ai_status['connected'] ) ) {
			$client_name = ! empty( $ai_status['client_name'] ) ? $ai_status['client_name'] : __( 'AI client', 'wpgo' );
			echo '<div class="wpgo-status"><strong class="wpgo-ok">✓ ' . esc_html( sprintf( __( '%s connected', 'wpgo' ), $client_name ) ) . '</strong><br><span class="wpgo-note">' . esc_html__( 'WPGo has verified the OAuth token exchange with the AI client.', 'wpgo' ) . '</span></div>';
		} else {
			echo '<div class="wpgo-status"><strong>' . esc_html__( 'WordPress ready — AI connection not yet verified', 'wpgo' ) . '</strong><br><span class="wpgo-note">' . esc_html__( 'This site is ready to connect, but WPGo has not yet seen a completed OAuth token exchange from Claude, ChatGPT or another AI client. WordPress readiness alone does not mean the AI is connected.', 'wpgo' ) . '</span></div>';
		}
		$events = isset( $ai_status['events'] ) && is_array( $ai_status['events'] ) ? $ai_status['events'] : array();
		if ( ! empty( $ai_status['last_seen_at'] ) || ! empty( $ai_status['last_refresh_at'] ) || ! empty( $ai_status['refresh_expires_at'] ) ) {
			echo '<div class="wpgo-card" style="margin-top:14px"><h2>' . esc_html__( 'Connection health', 'wpgo' ) . '</h2>';
			if ( ! empty( $ai_status['last_seen_at'] ) ) echo '<p><strong>' . esc_html__( 'Last AI activity:', 'wpgo' ) . '</strong> ' . esc_html( $ai_status['last_seen_at'] ) . '</p>';
			if ( ! empty( $ai_status['last_refresh_at'] ) ) echo '<p><strong>' . esc_html__( 'Last OAuth refresh:', 'wpgo' ) . '</strong> ' . esc_html( $ai_status['last_refresh_at'] ) . '</p>';
			if ( ! empty( $ai_status['refresh_expires_at'] ) ) echo '<p><strong>' . esc_html__( 'Refresh credential expiry:', 'wpgo' ) . '</strong> ' . esc_html( $ai_status['refresh_expires_at'] ) . '</p>';
			echo '</div>';
		}
		if ( ! empty( $events ) ) {
			echo '<div class="wpgo-card" style="margin-top:14px"><h2>' . esc_html__( 'Recent connection activity', 'wpgo' ) . '</h2>';
			foreach ( $events as $event ) {
				$type = sanitize_text_field( isset( $event['type'] ) ? $event['type'] : 'activity' );
				$time = sanitize_text_field( isset( $event['time'] ) ? $event['time'] : '' );
				echo '<p><strong>' . esc_html( $type ) . '</strong>' . ( $time ? ' · ' . esc_html( $time ) : '' ) . '</p>';
			}
			echo '</div>';
		}
		echo '<div class="wpgo-grid">';
		$this->render_provider_card(
			'Claude',
			__( 'Add a Custom Web connector, paste the site-specific MCP URL, choose Sign in now, then use Claude’s published identity.', 'wpgo' ),
			$mcp_url
		);
		$this->render_provider_card(
			'ChatGPT',
			__( 'Add WPGo as a remote/custom MCP connector. OAuth discovery is automatic; no OpenAI API key is required by WPGo.', 'wpgo' ),
			$mcp_url
		);
		$this->render_provider_card(
			__( 'Other MCP client', 'wpgo' ),
			__( 'Use the same URL in any standards-compatible remote MCP client that supports OAuth.', 'wpgo' ),
			$mcp_url
		);
		echo '</div>';
		echo '<div class="wpgo-card" style="margin-top:14px"><h2>' . esc_html__( 'Your site-specific MCP URL', 'wpgo' ) . '</h2><div class="wpgo-url">' . esc_html( $mcp_url ) . '</div><div class="wpgo-actions">';
		if ( ! empty( $connection['connection_page'] ) ) {
			echo '<a class="button button-primary" target="_blank" rel="noopener noreferrer" href="' . esc_url( $connection['connection_page'] ) . '">' . esc_html__( 'Open guided connection page', 'wpgo' ) . '</a>';
		}
		echo '</div><p class="wpgo-note">' . esc_html__( 'This URL identifies this WordPress site. It does not contain your WordPress password or Application Password. WordPress still asks you to approve access before the AI receives credentials.', 'wpgo' ) . '</p></div>';
		$this->render_refresh_button();
		echo '</div>';
	}

	private function render_provider_card( $title, $description, $mcp_url ) {
		echo '<article class="wpgo-card"><h2>' . esc_html( $title ) . '</h2><p>' . esc_html( $description ) . '</p><div class="wpgo-url">' . esc_html( $mcp_url ) . '</div></article>';
	}

	private function render_refresh_button() {
		$url = wp_nonce_url( admin_url( 'admin-post.php?action=wpgo_refresh_connect_ai' ), 'wpgo_refresh_connect_ai' );
		echo '<p><a class="button" href="' . esc_url( $url ) . '">' . esc_html__( 'Recheck connection readiness', 'wpgo' ) . '</a></p>';
	}
}

WPGo_Connect_AI::boot();
