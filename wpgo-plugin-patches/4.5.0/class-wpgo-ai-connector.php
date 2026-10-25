<?php
if ( ! defined( 'ABSPATH' ) ) { exit; }

/** WPGo 4.5.0 provider-neutral remote AI connection and MCP safety layer. */
final class WPGo_AI_Connector {
    const VERSION = '4.5.0';
    const REQUIRED_AGENT_VERSION = '1.33.1';
    const AGENT_PLUGIN = 'agent-connector-for-wp/agent-connector-for-wp.php';
    const AGENT_PACKAGE = 'https://github.com/soflyy/agent-connector-for-wp/releases/download/v1.33.1/agent-connector-for-wp.zip';
    const AGENT_SHA256 = 'ba7313feac5fed09cfec8d97b12bb2c1f6468fe5dd87c811e418b61310318e6b';
    const REPAIR_STATE_OPTION = 'wpgo_ai_connector_repair_450';

    public static function boot() {
        add_filter( 'wp_register_ability_args', array( __CLASS__, 'curate_ability' ), 90, 2 );
        add_action( 'wp_abilities_api_init', array( __CLASS__, 'register_status_abilities' ), 120 );
        add_action( 'admin_notices', array( __CLASS__, 'admin_notice' ) );
        add_action( 'admin_post_wpgo_repair_ai_connector', array( __CLASS__, 'handle_repair' ) );
    }

    private static function plugin_path() { return trailingslashit( WP_PLUGIN_DIR ) . self::AGENT_PLUGIN; }

    private static function plugin_version() {
        $file = self::plugin_path();
        if ( ! is_readable( $file ) ) return '';
        if ( ! function_exists( 'get_plugin_data' ) ) require_once ABSPATH . 'wp-admin/includes/plugin.php';
        $data = get_plugin_data( $file, false, false );
        return sanitize_text_field( (string) ( $data['Version'] ?? '' ) );
    }

    private static function allowed_namespaces() {
        $namespaces = apply_filters( 'wpgo_ai_allowed_namespaces', array( 'wpgo' ) );
        if ( ! is_array( $namespaces ) ) $namespaces = array( 'wpgo' );
        return array_values( array_unique( array_filter( array_map( 'sanitize_key', $namespaces ) ) ) );
    }

    public static function mcp_url() { return rest_url( 'mcp/mcp-adapter-default-server' ); }

    public static function discovery_url() {
        $path = wp_parse_url( self::mcp_url(), PHP_URL_PATH );
        return home_url( '/.well-known/oauth-protected-resource' . ( is_string( $path ) ? $path : '/wp-json/mcp/mcp-adapter-default-server' ) );
    }

    private static function transport_ready() {
        return is_ssl() || ( function_exists( 'wp_get_environment_type' ) && 'local' === wp_get_environment_type() );
    }

    public static function status() {
        if ( ! function_exists( 'is_plugin_active' ) ) require_once ABSPATH . 'wp-admin/includes/plugin.php';
        $installed = is_readable( self::plugin_path() );
        $version = $installed ? self::plugin_version() : '';
        $active = $installed && is_plugin_active( self::AGENT_PLUGIN );
        $version_ok = $version && version_compare( $version, self::REQUIRED_AGENT_VERSION, '>=' );
        $oauth_class = class_exists( '\\AgentConnectorForWp\\OAuth\\Server' );
        $interceptor = '\\AgentConnectorForWp\\OAuth\\Interceptor';
        $oauth_booted = $oauth_class && class_exists( $interceptor ) && false !== has_filter( 'rest_authentication_errors', array( $interceptor, 'authenticate' ) );
        $transport = self::transport_ready();

        return array(
            'version' => defined( 'WPGO_VERSION' ) ? WPGO_VERSION : self::VERSION,
            'ready' => (bool) ( $active && $version_ok && $oauth_class && $oauth_booted && $transport ),
            'connector' => 'oauth-remote-mcp',
            'protocol' => 'mcp',
            'transport' => 'streamable-http',
            'provider_neutral' => true,
            'mcp_url' => self::mcp_url(),
            'oauth_discovery_url' => self::discovery_url(),
            'supported_clients' => array( 'ChatGPT', 'Claude', 'other OAuth-capable MCP clients' ),
            'agent_connector_installed' => $installed,
            'agent_connector_active' => $active,
            'agent_connector_version' => $version,
            'required_agent_connector_version' => self::REQUIRED_AGENT_VERSION,
            'version_ok' => (bool) $version_ok,
            'oauth_runtime_loaded' => (bool) $oauth_class,
            'oauth_interceptor_active' => (bool) $oauth_booted,
            'secure_transport' => (bool) $transport,
            'manual_application_password_required' => false,
            'manual_auth_headers_required' => false,
            'default_public_namespaces' => self::allowed_namespaces(),
            'blocked_namespaces' => array( 'agent-connector-for-wp' ),
        );
    }

    public static function connection_profile() {
        $status = self::status();
        return array(
            'ready' => ! empty( $status['ready'] ),
            'protocol' => 'mcp',
            'transport' => 'streamable-http',
            'authentication' => 'oauth',
            'provider_neutral' => true,
            'mcp_url' => self::mcp_url(),
            'oauth_discovery_url' => self::discovery_url(),
            'instructions' => 'Add the MCP URL to any OAuth-capable remote MCP client and complete the browser authorization flow.',
        );
    }

    public static function curate_ability( $args, $name ) {
        $args = is_array( $args ) ? $args : array();
        $name = is_string( $name ) ? $name : '';
        $parts = explode( '/', $name, 2 );
        $ns = sanitize_key( (string) ( $parts[0] ?? '' ) );

        // Never expose the dependency's own high-privilege abilities through WPGo.
        if ( 'agent-connector-for-wp' === $ns ) {
            if ( ! isset( $args['meta'] ) || ! is_array( $args['meta'] ) ) $args['meta'] = array();
            $args['meta']['public'] = false;
            $args['meta']['mcp'] = array( 'public' => false );
            return $args;
        }

        if ( ! in_array( $ns, self::allowed_namespaces(), true ) ) return $args;
        if ( ! isset( $args['meta'] ) || ! is_array( $args['meta'] ) ) $args['meta'] = array();
        $args['meta']['mcp'] = array_merge(
            isset( $args['meta']['mcp'] ) && is_array( $args['meta']['mcp'] ) ? $args['meta']['mcp'] : array(),
            array( 'public' => true )
        );

        $ann = isset( $args['meta']['annotations'] ) && is_array( $args['meta']['annotations'] ) ? $args['meta']['annotations'] : array();
        if ( true === ( $ann['readonly'] ?? null ) || empty( $args['execute_callback'] ) || ! is_callable( $args['execute_callback'] ) ) return $args;

        $original = $args['execute_callback'];
        $destructive = true === ( $ann['destructive'] ?? null );
        $schema = isset( $args['input_schema'] ) && is_array( $args['input_schema'] ) ? $args['input_schema'] : array();

        // Writable non-object abilities cannot safely receive an approval token without changing their public contract.
        if ( ( $schema['type'] ?? 'object' ) !== 'object' ) {
            $args['meta']['mcp']['public'] = false;
            return $args;
        }

        if ( ! isset( $schema['properties'] ) || ! is_array( $schema['properties'] ) ) $schema['properties'] = array();
        $schema['properties']['approval_id'] = array(
            'type' => 'string',
            'minLength' => 8,
            'description' => 'WPGo approval ID returned by a previous call. Omit on the first call; after the user approves, retry with this ID.',
        );
        $args['input_schema'] = $schema;

        $args['execute_callback'] = static function( $input = array() ) use ( $original, $name, $destructive ) {
            $input = is_array( $input ) ? $input : array();
            $approval_id = sanitize_text_field( (string) ( $input['approval_id'] ?? '' ) );
            unset( $input['approval_id'] );
            $payload = array( 'ability' => $name, 'input' => $input );

            if ( ! class_exists( 'WPGo_Approvals' ) ) return new WP_Error( 'wpgo_ai_approval_unavailable', 'WPGo approval subsystem is unavailable.' );
            if ( ! $approval_id ) {
                return WPGo_Approvals::request(
                    'remote_mcp_ability',
                    $payload,
                    sprintf( '%s remote AI action: %s', $destructive ? 'Approve destructive' : 'Approve writable', $name )
                );
            }
            $authorized = WPGo_Approvals::authorize( $approval_id, 'remote_mcp_ability', $payload );
            if ( is_wp_error( $authorized ) ) return $authorized;
            return call_user_func( $original, $input );
        };
        return $args;
    }

    public static function register_status_abilities() {
        if ( ! function_exists( 'wp_register_ability' ) ) return;

        if ( ! function_exists( 'wp_get_ability' ) || ! wp_get_ability( 'wpgo/ai-connector-status' ) ) {
            wp_register_ability( 'wpgo/ai-connector-status', array(
                'label' => 'WPGo AI connector status',
                'description' => 'Reports whether secure OAuth remote MCP is ready for compatible AI clients.',
                'category' => 'wpgo',
                'input_schema' => array( 'type' => 'object', 'additionalProperties' => false ),
                'output_schema' => array(),
                'execute_callback' => array( __CLASS__, 'status' ),
                'permission_callback' => static function() { return current_user_can( 'manage_options' ); },
                'meta' => array( 'show_in_rest' => true, 'mcp' => array( 'public' => true ), 'annotations' => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ) ),
            ) );
        }

        if ( ! function_exists( 'wp_get_ability' ) || ! wp_get_ability( 'wpgo/ai-connection-profile' ) ) {
            wp_register_ability( 'wpgo/ai-connection-profile', array(
                'label' => 'WPGo AI connection profile',
                'description' => 'Returns the provider-neutral MCP endpoint and OAuth discovery URL for this site.',
                'category' => 'wpgo',
                'input_schema' => array( 'type' => 'object', 'additionalProperties' => false ),
                'output_schema' => array(),
                'execute_callback' => array( __CLASS__, 'connection_profile' ),
                'permission_callback' => static function() { return current_user_can( 'manage_options' ); },
                'meta' => array( 'show_in_rest' => true, 'mcp' => array( 'public' => true ), 'annotations' => array( 'readonly' => true, 'destructive' => false, 'idempotent' => true ) ),
            ) );
        }
    }

    /** Explicit administrator action only. WPGo never installs or updates this dependency silently. */
    public static function repair_dependency() {
        if ( ! current_user_can( 'manage_options' ) ) return new WP_Error( 'wpgo_ai_permission', 'Administrator permission is required.' );
        if ( ! self::transport_ready() ) return new WP_Error( 'wpgo_ai_https', 'Remote AI OAuth requires HTTPS.' );

        require_once ABSPATH . 'wp-admin/includes/plugin.php';
        require_once ABSPATH . 'wp-admin/includes/file.php';
        require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';

        $installed = is_readable( self::plugin_path() );
        $version = $installed ? self::plugin_version() : '';
        if ( ! $installed || ! $version || version_compare( $version, self::REQUIRED_AGENT_VERSION, '<' ) ) {
            $tmp = download_url( self::AGENT_PACKAGE, 60 );
            if ( is_wp_error( $tmp ) ) return new WP_Error( 'wpgo_ai_download', $tmp->get_error_message() );
            $actual = is_file( $tmp ) ? strtolower( (string) hash_file( 'sha256', $tmp ) ) : '';
            if ( ! $actual || ! hash_equals( self::AGENT_SHA256, $actual ) ) {
                @unlink( $tmp );
                return new WP_Error( 'wpgo_ai_hash', 'Agent Connector package integrity verification failed.' );
            }
            $upgrader = new Plugin_Upgrader( new Automatic_Upgrader_Skin() );
            $result = $upgrader->install( $tmp, array( 'overwrite_package' => true ) );
            @unlink( $tmp );
            if ( is_wp_error( $result ) ) return $result;
            if ( ! $result ) return new WP_Error( 'wpgo_ai_install', 'Agent Connector installation failed.' );
            clearstatcache( true, self::plugin_path() );
        }

        if ( ! is_plugin_active( self::AGENT_PLUGIN ) ) {
            $activated = activate_plugin( self::AGENT_PLUGIN, '', false, true );
            if ( is_wp_error( $activated ) ) return $activated;
        }
        add_option( 'agent_connector_for_wp_enabled', true, '', false );
        delete_site_transient( 'update_plugins' );
        update_option( self::REPAIR_STATE_OPTION, array( 'ok' => true, 'time' => time(), 'required_version' => self::REQUIRED_AGENT_VERSION ), false );
        if ( class_exists( 'WPGo_Audit' ) ) WPGo_Audit::log( 'ai_connector_repaired', array( 'agent_connector_version' => self::plugin_version() ) );
        return true;
    }

    public static function handle_repair() {
        if ( ! current_user_can( 'manage_options' ) ) wp_die( esc_html__( 'Permission denied.', 'wpgo' ) );
        check_admin_referer( 'wpgo_repair_ai_connector' );
        delete_option( self::REPAIR_STATE_OPTION );
        $result = self::repair_dependency();
        $a = array( 'page' => 'wpgo', 'tab' => 'connection', 'ai_repaired' => is_wp_error( $result ) ? '0' : '1' );
        if ( is_wp_error( $result ) ) $a['wpgo_error'] = rawurlencode( $result->get_error_message() );
        wp_safe_redirect( add_query_arg( $a, admin_url( 'tools.php' ) ) );
        exit;
    }

    public static function admin_notice() {
        if ( ! current_user_can( 'manage_options' ) || empty( $_GET['page'] ) || 'wpgo' !== sanitize_key( (string) $_GET['page'] ) ) return;
        $status = self::status();
        if ( ! empty( $status['ready'] ) ) {
            echo '<div class="notice notice-success"><p><strong>Remote AI connector ready.</strong> Use the same secure OAuth MCP URL with ChatGPT, Claude, or another compatible AI client: <code>' . esc_html( $status['mcp_url'] ) . '</code></p></div>';
            return;
        }
        $url = wp_nonce_url( admin_url( 'admin-post.php?action=wpgo_repair_ai_connector' ), 'wpgo_repair_ai_connector' );
        echo '<div class="notice notice-warning"><p><strong>Remote AI connector not ready.</strong> WPGo will not install or update the connector without your approval. <a class="button" style="margin-left:8px" href="' . esc_url( $url ) . '">Install / repair connector</a></p></div>';
    }
}
