<?php
/**
 * WPGo 4.5 RC3 agent-experience compatibility layer.
 *
 * Runs alongside the 4.4.x core during RC validation. The same fixes must be
 * folded into the single WPGo core plugin before GA.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class WPGo_Agent_Experience_RC3 {
	const VERSION = '4.5.0-rc.3';

	public static function boot() {
		// Override only the approval-safe proxy route, retaining the same URL and
		// capability boundary used by existing clients.
		add_action( 'rest_api_init', array( __CLASS__, 'register_proxy_route' ), 999 );
		// Repair legacy PHP empty-array JSON-Schema nodes before any MCP client
		// consumes WordPress Abilities metadata.
		add_filter( 'rest_post_dispatch', array( __CLASS__, 'repair_abilities_rest_schema' ), 20, 3 );
	}

	public static function register_proxy_route() {
		if ( ! class_exists( 'WP_REST_Server' ) ) {
			return;
		}
		register_rest_route(
			'wpgo/v1',
			'/abilities/run',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'permission_callback' => array( __CLASS__, 'can_manage' ),
				'callback'            => array( __CLASS__, 'run_ability_proxy' ),
			),
			true
		);
	}

	public static function can_manage() {
		return current_user_can( 'manage_options' );
	}

	private static function manifest() {
		if ( ! function_exists( 'wp_get_ability' ) ) {
			return array( 'read' => array(), 'write' => array(), 'recipes' => array() );
		}
		$ability = wp_get_ability( 'wpgo/platform-manifest' );
		if ( ! $ability ) {
			return array( 'read' => array(), 'write' => array(), 'recipes' => array() );
		}
		$result = $ability->execute( array() );
		if ( is_wp_error( $result ) || ! is_array( $result ) ) {
			return array( 'read' => array(), 'write' => array(), 'recipes' => array() );
		}
		$commands = isset( $result['commands'] ) && is_array( $result['commands'] ) ? $result['commands'] : array();
		return array(
			'read'    => array_values( array_unique( array_filter( array_map( 'strval', (array) ( $commands['read'] ?? array() ) ) ) ) ),
			'write'   => array_values( array_unique( array_filter( array_map( 'strval', (array) ( $commands['write'] ?? array() ) ) ) ) ),
			'recipes' => array_values( array_unique( array_filter( array_map( 'strval', (array) ( $result['recipes'] ?? array() ) ) ) ) ),
		);
	}

	private static function nearest( $needle, $candidates ) {
		$needle = trim( (string) $needle );
		if ( '' === $needle ) {
			return '';
		}
		$best = '';
		$score = PHP_INT_MAX;
		foreach ( (array) $candidates as $candidate ) {
			$candidate = (string) $candidate;
			$distance  = levenshtein( $needle, $candidate );
			$left      = strtok( $needle, '.' );
			$right     = strtok( $candidate, '.' );
			if ( $left && $right && $left === $right ) {
				$distance--;
			}
			if ( $distance < $score ) {
				$score = $distance;
				$best  = $candidate;
			}
		}
		$threshold = max( 3, (int) ceil( strlen( $needle ) * 0.45 ) );
		return $score <= $threshold ? $best : '';
	}

	private static function unknown_command( $command, $valid, $path = 'command' ) {
		$suggestion = self::nearest( $command, $valid );
		$message = sprintf( 'Unknown WPGo command "%s" at %s.', $command, $path );
		if ( $suggestion ) {
			$message .= sprintf( ' Did you mean "%s"?', $suggestion );
		}
		return new WP_Error(
			'wpgo_command_unknown',
			$message,
			array(
				'status'           => 400,
				'suggestion'       => $suggestion,
				'valid_commands'   => array_values( $valid ),
				'preflight'        => true,
				'approval_created' => false,
			)
		);
	}

	private static function safe_option_names() {
		if ( ! function_exists( 'wp_get_ability' ) ) {
			return array();
		}
		$ability = wp_get_ability( 'wpgo/command-read' );
		if ( ! $ability ) {
			return array();
		}
		$result = $ability->execute( array( 'command' => 'option.safe-list', 'args' => array() ) );
		if ( is_wp_error( $result ) || ! is_array( $result ) ) {
			return array();
		}
		foreach ( array( 'options', 'names', 'allowed', 'safe_options' ) as $key ) {
			if ( isset( $result[ $key ] ) && is_array( $result[ $key ] ) ) {
				return array_values( array_map( 'strval', $result[ $key ] ) );
			}
		}
		return array();
	}

	private static function validate_command_args( $command, $args, $path ) {
		if ( 'option.update' !== $command ) {
			return true;
		}
		$name = (string) ( $args['name'] ?? $args['option'] ?? $args['option_name'] ?? '' );
		$allowed = self::safe_option_names();
		if ( $name && $allowed && ! in_array( $name, $allowed, true ) ) {
			return new WP_Error(
				'wpgo_option_not_allowlisted',
				sprintf( 'Option "%s" is not on WPGo\'s safe generic write allowlist.', $name ),
				array( 'status' => 400, 'preflight' => true, 'approval_created' => false, 'path' => $path )
			);
		}
		return true;
	}

	private static function preflight( $name, $input ) {
		$manifest = self::manifest();
		$input    = is_array( $input ) ? $input : array();

		if ( 'wpgo/upload-media-from-url' === $name && class_exists( 'WPGo_Media_Abilities_RC3' ) ) {
			return WPGo_Media_Abilities_RC3::preflight_remote_url( $input['url'] ?? '' );
		}

		if ( 'wpgo/command-read' === $name || 'wpgo/command-write' === $name ) {
			$command = (string) ( $input['command'] ?? '' );
			$valid   = 'wpgo/command-read' === $name ? $manifest['read'] : $manifest['write'];
			if ( $valid && ! in_array( $command, $valid, true ) ) {
				return self::unknown_command( $command, $valid );
			}
			return self::validate_command_args( $command, (array) ( $input['args'] ?? array() ), 'args' );
		}

		if ( 'wpgo/create-job' === $name ) {
			$valid = array_values( array_unique( array_merge( $manifest['read'], $manifest['write'] ) ) );
			foreach ( (array) ( $input['steps'] ?? array() ) as $index => $step ) {
				$step    = is_array( $step ) ? $step : array();
				$command = (string) ( $step['command'] ?? '' );
				if ( $valid && ! in_array( $command, $valid, true ) ) {
					return self::unknown_command( $command, $valid, 'steps[' . $index . '].command' );
				}
				$arg_check = self::validate_command_args( $command, (array) ( $step['args'] ?? array() ), 'steps[' . $index . '].args' );
				if ( is_wp_error( $arg_check ) ) {
					return $arg_check;
				}
			}
		}

		if ( 'wpgo/run-recipe' === $name && $manifest['recipes'] ) {
			$recipe = (string) ( $input['recipe'] ?? $input['name'] ?? '' );
			if ( ! in_array( $recipe, $manifest['recipes'], true ) ) {
				$suggestion = self::nearest( $recipe, $manifest['recipes'] );
				return new WP_Error(
					'wpgo_recipe_unknown',
					$suggestion ? sprintf( 'Unknown WPGo recipe "%s". Did you mean "%s"?', $recipe, $suggestion ) : sprintf( 'Unknown WPGo recipe "%s".', $recipe ),
					array( 'status' => 400, 'suggestion' => $suggestion, 'valid_recipes' => $manifest['recipes'], 'preflight' => true, 'approval_created' => false )
				);
			}
		}

		return true;
	}

	private static function slash_post_args( $args ) {
		$args = is_array( $args ) ? $args : array();
		foreach ( array( 'title', 'post_title', 'content', 'post_content', 'excerpt', 'post_excerpt' ) as $key ) {
			if ( isset( $args[ $key ] ) && is_string( $args[ $key ] ) ) {
				$args[ $key ] = wp_slash( $args[ $key ] );
			}
		}
		return $args;
	}

	/** Public for the standalone RC regression fixture. */
	public static function normalize_write_input( $name, $input ) {
		$input = is_array( $input ) ? $input : array();
		if ( 'wpgo/command-write' === $name && in_array( (string) ( $input['command'] ?? '' ), array( 'post.create', 'post.update' ), true ) ) {
			$input['args'] = self::slash_post_args( $input['args'] ?? array() );
		}
		if ( 'wpgo/create-job' === $name && isset( $input['steps'] ) && is_array( $input['steps'] ) ) {
			foreach ( $input['steps'] as $index => $step ) {
				if ( is_array( $step ) && in_array( (string) ( $step['command'] ?? '' ), array( 'post.create', 'post.update' ), true ) ) {
					$input['steps'][ $index ]['args'] = self::slash_post_args( $step['args'] ?? array() );
				}
			}
		}
		if ( 'wpgo/create-categorized-post' === $name ) {
			$input = self::slash_post_args( $input );
		}
		return $input;
	}

	private static function approval_summary( $name, $input, $destructive ) {
		$input = is_array( $input ) ? $input : array();
		if ( 'wpgo/create-job' === $name ) {
			$steps = (array) ( $input['steps'] ?? array() );
			$counts = array();
			foreach ( $steps as $step ) {
				$command = is_array( $step ) ? (string) ( $step['command'] ?? 'unknown' ) : 'unknown';
				$counts[ $command ] = ( $counts[ $command ] ?? 0 ) + 1;
			}
			$parts = array();
			foreach ( $counts as $command => $count ) {
				$parts[] = $count . ' × ' . $command;
			}
			return sprintf( 'Run exact WPGo plan: %d steps — %s', count( $steps ), implode( '; ', array_slice( $parts, 0, 8 ) ) );
		}
		if ( 'wpgo/command-write' === $name ) {
			return sprintf( 'Run WordPress command %s', (string) ( $input['command'] ?? 'write' ) );
		}
		$labels = array(
			'wpgo/managed-css-publish'              => 'Publish a versioned managed CSS revision',
			'wpgo/set-kadence-page-meta'            => 'Update safe Kadence page settings',
			'wpgo/elementor-edit'                    => 'Edit Elementor content',
			'wpgo/structured-builder-node-edit'      => 'Edit one structured builder node',
			'wpgo/structured-builder-batch-edit'     => 'Apply a structured builder edit plan',
			'wpgo/upload-media-from-url'             => 'Upload one media file from a validated public HTTPS URL',
			'wpgo/request-media-upload'              => 'Create a short-lived local-device media upload session',
			'wpgo/theme-setting-update'              => 'Update one reviewed safe theme setting',
		);
		if ( isset( $labels[ $name ] ) ) {
			return $labels[ $name ];
		}
		return sprintf( '%s WordPress ability %s', $destructive ? 'Run destructive' : 'Run writable', $name );
	}

	public static function run_ability_proxy( WP_REST_Request $request ) {
		if ( ! function_exists( 'wp_get_ability' ) ) {
			return new WP_Error( 'wpgo_abilities_unavailable', __( 'WordPress Abilities API is unavailable.', 'wpgo' ), array( 'status' => 409 ) );
		}
		$name = sanitize_text_field( (string) $request->get_param( 'ability' ) );
		if ( ! preg_match( '/^[a-z0-9-]+\/[a-z0-9-]+$/', $name ) ) {
			return new WP_Error( 'wpgo_ability_name', __( 'Invalid ability name.', 'wpgo' ), array( 'status' => 400 ) );
		}
		$ability = wp_get_ability( $name );
		if ( ! $ability ) {
			return new WP_Error( 'wpgo_ability_missing', __( 'Ability not found.', 'wpgo' ), array( 'status' => 404 ) );
		}
		$meta = method_exists( $ability, 'get_meta' ) ? (array) $ability->get_meta() : array();
		if ( empty( $meta['show_in_rest'] ) ) {
			return new WP_Error( 'wpgo_ability_not_exposed', __( 'Ability author did not expose this ability to REST/external execution.', 'wpgo' ), array( 'status' => 403 ) );
		}
		$annotations = isset( $meta['annotations'] ) && is_array( $meta['annotations'] ) ? $meta['annotations'] : array();
		$readonly = ! empty( $annotations['readonly'] );
		$destructive = ! empty( $annotations['destructive'] );
		$raw_input = $request->get_param( 'input' );
		$raw_input = null === $raw_input ? null : $raw_input;

		$preflight = self::preflight( $name, $raw_input );
		if ( is_wp_error( $preflight ) ) {
			return $preflight;
		}

		$summary = self::approval_summary( $name, $raw_input, $destructive );
		$input = self::normalize_write_input( $name, $raw_input );

		if ( ! $readonly ) {
			$payload = array( 'ability' => $name, 'input' => $input );
			$approval_id = sanitize_text_field( (string) $request->get_param( 'approval_id' ) );
			if ( ! $approval_id ) {
				$response = WPGo_Approvals::request( 'ability_run', $payload, $summary );
				if ( is_array( $response ) ) {
					$response['preflight_passed'] = true;
					$response['approval_summary'] = $summary;
				}
				return rest_ensure_response( $response );
			}
			$authorized = WPGo_Approvals::authorize( $approval_id, 'ability_run', $payload );
			if ( is_wp_error( $authorized ) ) {
				return $authorized;
			}
		}

		$result = $ability->execute( $input );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		WPGo_Audit::log( 'ability_run', array( 'ability' => $name, 'readonly' => $readonly, 'destructive' => $destructive, 'rc3_preflight' => true ) );
		return rest_ensure_response( array( 'ability' => $name, 'readonly' => $readonly, 'destructive' => $destructive, 'result' => $result ) );
	}

	private static function repair_schema_node( $schema ) {
		if ( true === $schema || false === $schema ) {
			return $schema;
		}
		if ( is_array( $schema ) && empty( $schema ) ) {
			return (object) array();
		}
		if ( ! is_array( $schema ) ) {
			return (object) array();
		}
		$map_keys = array( 'properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas' );
		foreach ( $map_keys as $key ) {
			if ( isset( $schema[ $key ] ) && is_array( $schema[ $key ] ) ) {
				foreach ( $schema[ $key ] as $name => $child ) {
					$schema[ $key ][ $name ] = self::repair_schema_node( $child );
				}
			}
		}
		$single_keys = array( 'additionalProperties', 'contains', 'else', 'if', 'items', 'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties' );
		foreach ( $single_keys as $key ) {
			if ( array_key_exists( $key, $schema ) ) {
				$schema[ $key ] = self::repair_schema_node( $schema[ $key ] );
			}
		}
		foreach ( array( 'allOf', 'anyOf', 'oneOf', 'prefixItems' ) as $key ) {
			if ( isset( $schema[ $key ] ) && is_array( $schema[ $key ] ) ) {
				foreach ( $schema[ $key ] as $index => $child ) {
					$schema[ $key ][ $index ] = self::repair_schema_node( $child );
				}
			}
		}
		return $schema;
	}

	public static function repair_abilities_rest_schema( $response, $server, $request ) {
		if ( ! $request instanceof WP_REST_Request || 0 !== strpos( $request->get_route(), '/wp-abilities/v1/abilities' ) ) {
			return $response;
		}
		if ( is_wp_error( $response ) ) {
			return $response;
		}
		$data = $response instanceof WP_REST_Response ? $response->get_data() : null;
		if ( is_array( $data ) ) {
			$rows = isset( $data['name'] ) ? array( $data ) : $data;
			foreach ( $rows as $index => $row ) {
				if ( is_array( $row ) && isset( $row['input_schema'] ) ) {
					$rows[ $index ]['input_schema'] = self::repair_schema_node( $row['input_schema'] );
				}
			}
			$data = isset( $data['name'] ) ? $rows[0] : $rows;
			$response->set_data( $data );
		}
		return $response;
	}
}

WPGo_Agent_Experience_RC3::boot();
