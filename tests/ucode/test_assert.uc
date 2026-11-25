import { assert_eq } from './assert.uc';

// Returns true if the callback raised (i.e. the assertion failed).
function fails(cb) {
	try {
		cb();
	} catch (e) {
		return true;
	}
	return false;
}

assert_eq(1 + 1, 2, 'scalars equal');
assert_eq('a', 'a', 'strings equal');
assert_eq(null, null, 'null equals null');

assert_eq([0, 128, 255], [0, 128, 255], 'equal arrays pass');
assert_eq(fails(() => assert_eq([1, 2, 3], [1, 2, 4])), true, 'different arrays fail');
assert_eq(fails(() => assert_eq([1, 2], [1, 2, 3])), true, 'arrays of different length fail');

assert_eq({ a: 1, b: [1, { c: 'x' }] }, { b: [1, { c: 'x' }], a: 1 }, 'nested objects pass (key order irrelevant)');
assert_eq(fails(() => assert_eq({ a: { b: 1 } }, { a: { b: 2 } })), true, 'nested value difference fails');
assert_eq(fails(() => assert_eq({ a: 1 }, { a: 1, b: 2 })), true, 'different key set fails');
assert_eq(fails(() => assert_eq({ a: 1 }, { b: 1 })), true, 'different key names fail');

assert_eq(fails(() => assert_eq(1, '1')), true, 'int vs string fails');
assert_eq(fails(() => assert_eq(1, 1.0)), true, 'int vs double fails (strict types)');
assert_eq(fails(() => assert_eq([1], { '0': 1 })), true, 'array vs object fails');
assert_eq(fails(() => assert_eq([1, [2]], [1, ['2']])), true, 'nested type mismatch fails');

print("test_assert: ok\n");
