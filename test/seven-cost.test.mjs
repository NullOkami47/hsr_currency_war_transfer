import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import { getChinaRoleOptions } from '../src/search.mjs';

test('Aha groups costs 4, 5 and 7 while retaining all searchable variant IDs', () => {
 const roles = getChinaRoleOptions({role_list: [4,5,7].map((rarity,i)=>({id:['151112','151122','151132'][i],name:'星神★阿哈',icon:'aha.png',big_icon:'aha-large.png',rarity:String(rarity)}))});
 assert.equal(roles.length,1);
 assert.deepEqual(roles[0].costs,['4','5','7']);
 assert.deepEqual(roles[0].matchIds,['151112','151122','151132']);
});

test('seven-cost Aha passes category filtering and receives a red portrait class', async () => {
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
 const costs=source.slice(source.indexOf('function roleCosts('),source.indexOf('\nfunction ',source.indexOf('function roleMatchesCategory(')+1));
 const portrait=source.slice(source.indexOf('function portrait('),source.indexOf('\nfunction roleFilterIcon'));
 const context=vm.createContext({state:{roleCategoryFilter:'cost-7'},roleName:r=>r.name,document:{createElement(){return {classList:{values:[],add(v){this.values.push(v)}},setAttribute(){},append(){}}}}});
 vm.runInContext(costs+'\n'+portrait,context);
 assert.equal(vm.runInContext("roleMatchesCategory({costs:['4','5','7']})",context),true);
 assert.equal(vm.runInContext("portrait({name:'星神★阿哈',displayCost:'7'}).classList.values.includes('portrait--cost-7')",context),true);
 assert.equal(vm.runInContext("portrait({name:'星神★阿哈',displayCost:'4'},'small','7').classList.values.includes('portrait--cost-7')",context),true);
 assert.equal(vm.runInContext("roleCosts({costs:['6','7','8']}).join(',')",context),'7');
});
