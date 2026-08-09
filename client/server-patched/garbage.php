<?php

/*
 * garbage.php — streaming replacement for the stock LibreSpeed version.
 *
 * The stock file calls ini_set('output_buffering','Off'), but ini_set cannot
 * turn off a buffer that PHP has already opened, and on cPanel / shared hosting
 * output_buffering is usually forced on in php.ini. The result: PHP holds the
 * ENTIRE response in memory before shipping a single byte. Ask for 50MB and you
 * hit memory_limit, PHP returns HTTP 500, and the client counts zero bytes.
 *
 * This version closes any buffer that is already open, sends no Content-Length
 * (so nothing has to buffer to measure it), and writes in 256KB blocks. Memory
 * stays flat and the first byte leaves immediately at any ckSize.
 */

@ini_set('zlib.output_compression', 'Off');
@ini_set('output_buffering', 'Off');
@ini_set('implicit_flush', '1');
@ini_set('max_execution_time', '0');
@set_time_limit(0);

// Close every buffer that is already open — this is the part ini_set cannot do.
while (ob_get_level() > 0) {
    @ob_end_clean();
}
@ob_implicit_flush(true);

// Stop Apache's mod_deflate from compressing (and therefore buffering) this.
if (function_exists('apache_setenv')) {
    @apache_setenv('no-gzip', '1');
    @apache_setenv('dont-vary', '1');
}

/**
 * @return int number of 1MB chunks to send
 */
function getChunkCount()
{
    if (
        !array_key_exists('ckSize', $_GET)
        || !ctype_digit($_GET['ckSize'])
        || (int) $_GET['ckSize'] <= 0
    ) {
        return 4;
    }

    if ((int) $_GET['ckSize'] > 1024) {
        return 1024;
    }

    return (int) $_GET['ckSize'];
}

header('HTTP/1.1 200 OK');

if (isset($_GET['cors'])) {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST');
}

// Lets the browser read precise Resource Timing values cross-origin.
header('Timing-Allow-Origin: *');

header('Content-Description: File Transfer');
header('Content-Type: application/octet-stream');
header('Content-Disposition: attachment; filename=random.dat');
header('Content-Transfer-Encoding: binary');
header('Content-Encoding: none');

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0');
header('Cache-Control: post-check=0, pre-check=0', false);
header('Pragma: no-cache');

// Deliberately no Content-Length: the response is streamed, not buffered.

$chunks = getChunkCount();

// 256KB block, generated once. Random so nothing on the path can compress it.
$block = openssl_random_pseudo_bytes(262144);
$blocks = $chunks * 4;

for ($i = 0; $i < $blocks; $i++) {
    echo $block;
    if (connection_aborted()) {
        break;
    }
}
