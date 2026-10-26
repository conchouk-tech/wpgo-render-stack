<?php
// Standalone RC3 regression for the write-boundary normalization helper.
define( 'ABSPATH', __DIR__ . '/' );

function wp_slash( $value ) {
	if ( is_array( $value ) ) {
		return array_map( 'wp_slash', $value );
	}
	if ( is_string( $value ) ) {
		return addslashes( $value );
	}
	return $value;
}

require_once dirname( __DIR__ ) . '/includes/class-wpgo-agent-experience.php';

$original = <<<'CONTENT'
<!-- wp:kadence/rowlayout {"uniqueID":"bn-shelf--tight","className":"bn-shelf\\featured"} -->
<div class="bn-shelf--tight" data-json='{"quote":"A \\"safe\\" value","path":"C:\\\\books\\\\beneath"}'>\literal\backslash</div>
<!-- /wp:kadence/rowlayout -->
CONTENT;

$input = array(
	'command' => 'post.update',
	'args'    => array(
		'title'   => "Author's shelf",
		'content' => $original,
		'excerpt' => 'Backslash \\ and quote " test',
	),
);

$normalized = WPGo_Agent_Experience_RC3::normalize_write_input( 'wpgo/command-write', $input );

if ( wp_unslash_compat( $normalized['args']['content'] ) !== $original ) {
	fwrite( STDERR, "Content did not survive the simulated WordPress unslash boundary.\n" );
	exit( 1 );
}
if ( wp_unslash_compat( $normalized['args']['title'] ) !== $input['args']['title'] ) {
	fwrite( STDERR, "Title did not survive the simulated WordPress unslash boundary.\n" );
	exit( 1 );
}
if ( wp_unslash_compat( $normalized['args']['excerpt'] ) !== $input['args']['excerpt'] ) {
	fwrite( STDERR, "Excerpt did not survive the simulated WordPress unslash boundary.\n" );
	exit( 1 );
}

$job = WPGo_Agent_Experience_RC3::normalize_write_input(
	'wpgo/create-job',
	array(
		'steps' => array(
			array( 'command' => 'post.create', 'args' => array( 'content' => $original ) ),
			array( 'command' => 'menu.add-post', 'args' => array( 'title' => "Don't slash menu data" ) ),
		),
	)
);
if ( wp_unslash_compat( $job['steps'][0]['args']['content'] ) !== $original ) {
	fwrite( STDERR, "Job post content did not survive simulated WordPress unslash.\n" );
	exit( 1 );
}
if ( $job['steps'][1]['args']['title'] !== "Don't slash menu data" ) {
	fwrite( STDERR, "Non-post job arguments were unexpectedly modified.\n" );
	exit( 1 );
}

fwrite( STDOUT, "WPGo RC3 content round-trip regression passed.\n" );

function wp_unslash_compat( $value ) {
	if ( is_array( $value ) ) {
		return array_map( 'wp_unslash_compat', $value );
	}
	return is_string( $value ) ? stripslashes( $value ) : $value;
}
