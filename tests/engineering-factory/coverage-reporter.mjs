// Test infrastructure: Node's documented test:coverage summary, not a PR-authored
// percentage or cached artifact. This reporter runs in the CI test process.
import {execFileSync} from 'node:child_process';
import {relative, resolve, sep} from 'node:path';
import {coverageFromNodeSummary} from '../../tools/engineering-factory/coverage-evidence.mjs';
const root=process.cwd();
const component=path=>relative(root,resolve(root,path)).split(sep).join('/').replace(/^tools\/(engineering-factory|engineering-coordinator)\//,'$1.').replace(/\.mjs$/,'');
export default async function* reporter(events){
 const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const expectedHead=process.env.FACTORY_EXPECTED_HEAD;
 // CI must supply the independent candidate SHA. Local runs may use the
 // checkout's HEAD for diagnostic coverage only, never trusted CI evidence.
 if((process.env.GITHUB_ACTIONS==='true'&&!expectedHead)||(expectedHead&&head!==expectedHead))
  throw Error('COVERAGE_HEAD_MISMATCH');
 const paths=execFileSync('git',['ls-files','-z','--','tools/engineering-factory/*.mjs','tools/engineering-coordinator/*.mjs'],{encoding:'utf8'}).split('\0').filter(Boolean);
 const expected=paths.map(component);
 let evidence;
 for await(const event of events){
  if(event.type!=='test:coverage')continue;
  if(evidence)throw Error('DUPLICATE_COVERAGE_SUMMARY');
  const files=event.data?.summary?.files;
  if(!Array.isArray(files))throw Error('MISSING_COVERAGE_FILES');
  evidence=coverageFromNodeSummary(head,expected,files.map(f=>({...f,component:component(f.path)})));
  if(!evidence.valid)throw Error('COVERAGE_EVIDENCE_'+evidence.reason);
 }
 if(!evidence)throw Error('MISSING_COVERAGE_SUMMARY');
 yield JSON.stringify({...evidence,localDiagnostic:process.env.GITHUB_ACTIONS!=='true'})+'\n';
}
