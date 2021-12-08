/*
 * Deepkit Framework
 * Copyright Deepkit UG, Marc J. Schmidt
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the MIT License.
 *
 * You should have received a copy of the MIT License along with this program.
 */

import { expect, test } from '@jest/globals';
import { typeOf } from '../../../src/reflection/reflection';
import { ReflectionKind, Type } from '../../../src/reflection/type';

test('array stack', () => {
    type Pop<T extends unknown[]> = T extends [...infer U, unknown] ? U : never
    type Push<T extends unknown[], U> = [...T, U]
    type Shift<T extends unknown[]> = T extends [unknown, ...infer U] ? U : never
    type Unshift<T extends unknown[], U> = [U, ...T]
});

test('StringToNum', () => {
    type test<A extends 0[] = []> = `${A["length"]}`;
    expect(typeOf<test>()).toEqual({kind: ReflectionKind.literal, literal: "0"} as Type);

    type StringToNum<T extends string, A extends 0[] = []> = `${A["length"]}` extends T ? A["length"] : StringToNum<T, [...A, 0]>;
    expect(typeOf<StringToNum<'3'>>()).toEqual({kind: ReflectionKind.literal, literal: 3} as Type);
});
