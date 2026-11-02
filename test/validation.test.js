import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDecimalToAtomic, validAtomic, validEvmAddress, validTxHash } from '../src/services/validation.js';

test('converts decimal amounts without floating-point arithmetic',()=>{
 assert.equal(parseDecimalToAtomic('1.25',6),'1250000');
 assert.equal(parseDecimalToAtomic('0.00000001',18),'10000000000');
 assert.equal(parseDecimalToAtomic('5',6),'5000000');
});
test('rejects excess precision, zero, negative, exponent, and malformed inputs',()=>{
 for(const value of ['0.0000001','0','-1','1e3','01','1.']) assert.throws(()=>parseDecimalToAtomic(value,6));
});
test('validates atomic strings and EVM public identifiers',()=>{
 assert.equal(validAtomic('1'),true);assert.equal(validAtomic('0'),false);assert.equal(validAtomic('1.0'),false);
 assert.equal(validEvmAddress('0x'+'a'.repeat(40)),true);assert.equal(validEvmAddress('0x123'),false);
 assert.equal(validTxHash('0x'+'b'.repeat(64)),true);assert.equal(validTxHash('0x123'),false);
});
