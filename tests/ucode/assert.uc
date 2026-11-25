// Minimal assertion helpers for the ucode unit tests.
// A failed assertion prints a message to stderr and throws, which makes the
// ucode interpreter (and therefore tests/ucode/run.sh) exit non-zero.
import { stderr } from 'fs';

function fail(msg, detail) {
	stderr.write(sprintf("FAIL: %s\n      %s\n", msg ?? '(no message)', detail));
	die(sprintf("assertion failed: %s", msg ?? ''));
}

// Deep structural equality with a strict type check at every level
// (an int never equals a double, a string never equals a number, ...).
function deep_equal(a, b) {
	let ta = type(a);

	if (ta != type(b))
		return false;

	if (ta == 'array') {
		if (length(a) != length(b))
			return false;
		for (let i = 0; i < length(a); i++)
			if (!deep_equal(a[i], b[i]))
				return false;
		return true;
	}

	if (ta == 'object') {
		let ka = sort(keys(a)), kb = sort(keys(b));
		if (length(ka) != length(kb))
			return false;
		for (let i = 0; i < length(ka); i++)
			if (ka[i] != kb[i] || !deep_equal(a[ka[i]], b[kb[i]]))
				return false;
		return true;
	}

	return a == b;
}

export function assert_eq(actual, expected, msg) {
	if (!deep_equal(actual, expected))
		fail(msg, sprintf("expected %J, got %J", expected, actual));
};

export function assert_near(actual, expected, eps, msg) {
	if (type(actual) != 'int' && type(actual) != 'double')
		fail(msg, sprintf("expected a number near %J, got %J", expected, actual));
	let d = actual - expected;
	if (d < 0)
		d = -d;
	if (d > eps)
		fail(msg, sprintf("expected %J +/- %J, got %J", expected, eps, actual));
};
