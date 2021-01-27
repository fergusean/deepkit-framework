const fs = require('fs');

const packages = fs.readdirSync('packages/');

for (const name of packages) {
    const path = `packages/${name}`;
    if (!fs.lstatSync(path).isDirectory()) continue;

    const packageJsonPath = `${path}/package.json`;
    const tsConfigPath = `${path}/tsconfig.json`;
    const tsConfigCjsPath = `${path}/tsconfig.esm.json`;

    if (!fs.existsSync(packageJsonPath)) throw new Error(`package ${name} has no package.json`);
    if (!fs.existsSync(tsConfigPath)) continue;

    console.log('processing', name, tsConfigPath);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, { encoding: 'utf8' }));
    const tsReferences = new Set();
    const tsConfigString = fs.readFileSync(tsConfigPath, { encoding: 'utf8' });
    try {
        const tsConfig = JSON.parse(tsConfigString);

        if (tsConfig['references']) {
            try {
                if (fs.existsSync(tsConfigCjsPath)) {
                    const tsConfigCjs = JSON.parse(fs.readFileSync(tsConfigCjsPath, {encoding: 'utf8'}));
                    tsConfigCjs['references'] = tsConfig['references'].map(v => {
                        return {path: v.path.replace('tsconfig.json', 'tsconfig.esm.json')}
                    });
                    fs.writeFileSync(tsConfigCjsPath, JSON.stringify(tsConfigCjs, undefined, 2));
                }
            } catch (error) {
                console.log('tsconfig.esm.json', tsConfigString);
                throw error;
            }

            for (const dep of tsConfig['references']) {
                let path = dep['path'];
                if (path.startsWith('../')) {
                    path = path.substr(path.indexOf('/') + 1);
                    path = path.substr(0, path.lastIndexOf('/'));
                    tsReferences.add('@deepkit/' + path);
                }
            }
        } else {
            continue;
        }
    } catch (error) {
        console.log('tsconfig.json', tsConfigString);
        throw error;
    }

    let deps = [...Object.keys(packageJson['dependencies'] || {}), ...Object.keys(packageJson['devDependencies'] || {})];

    // console.log('   -> ts references', [...tsReferences]);
    // console.log('   -> deps', deps);

    for (const dep of deps) {
        if (dep.startsWith('@deepkit/')) {
            if (!tsReferences.has(dep)) {
                console.log(`  ERR: ${dep} as dependency, but not in tsconfig.json references.`);
            }
        }
    }
}
