import { assert_eq, assert_near } from './assert.uc';

assert_eq(1 + 1, 2, 'arithmetic works');
assert_near(0.1 + 0.2, 0.3, 1e-9, 'floating point is near');
print("test_skeleton: ok\n");
