#!/usr/bin/env node
import select, { Separator } from '@inquirer/select';
import { input, password, confirm } from '@inquirer/prompts';
import checkbox from '@inquirer/checkbox';
import util from 'util';
import child from 'child_process';
const exec = util.promisify(child.exec);

async function tanzu_restage() {

    const tanzu_foundation = await input({ message: 'Select a Tanzu foundation' });

    // Ask if user wants to ignore apps restarted in the last 24 hours
    const ignore_recent_restage = await confirm({
        message: 'Ignore apps restaged in the last 24 hours?',
        default: true
    });

    let result = '';

    // Set the foundation
    result = await exec('cf api ' + tanzu_foundation);
    //console.log(result.stdout);

    // Login
    const username = await input({ message: 'Enter your username' });
    const password_ = await password({ message: 'Enter your password', mask: '*' });
    result = await exec('cf auth ' + username + ' ' + password_);
    //console.log(result.stdout);

    // Get the orgs
    console.log("\nGetting orgs...");
    result = await exec('cf orgs');
    //console.log("result.stdout", result.stdout);
    let orgs_array = result.stdout.split("\n");
    let orgs = [];
    for (let i = 3; i < orgs_array.length - 1; i++) {
        orgs.push({
            "name": orgs_array[i],
            "value": orgs_array[i]
        });
    }

    // Select the orgs
    let selected_orgs = await checkbox({
        message: 'Select the orgs',
        choices: orgs,
    });

    // Iterate through orgs to get spaces
    console.log("\nGetting spaces...");
    let spaces = [];
    for (let i = 0; i < selected_orgs.length; i++) {

        let org = selected_orgs[i];
        await exec('cf target -o ' + org);
        result = await exec('cf spaces');
        //console.log("result.stdout", result.stdout);
        let spaces_array = result.stdout.split("\n");

        for (let i = 3; i < spaces_array.length - 1; i++) {
            spaces.push({
                "name": spaces_array[i],
                "value": {
                    "org": org,
                    "space": spaces_array[i]
                }
            });
        }

    }

    // Select the spaces
    let selected_spaces = await checkbox({
        message: 'Select the spaces',
        choices: spaces,
    });

    // Iterate through spaces to get apps
    console.log("\nGetting apps...");
    let apps = [];
    for (let i = 0; i < selected_spaces.length; i++) {

        let org = selected_spaces[i].org;
        let space = selected_spaces[i].space;
        await exec('cf target -o ' + org + ' -s ' + space);
        result = await exec('cf apps');
        let apps_array = result.stdout.split("\n");

        for (let i = 3; i < apps_array.length - 1; i++) {

            let app_info = apps_array[i].split(/\s+/);
            let app_name = app_info[0];
            let app_state = app_info[1];
            
            // Get the app guid
            result = await exec('cf app ' + app_name + ' --guid');
            let app_guid = result.stdout.split("\n")[0];

            // Check if app was restarted in the last 24 hours
            if (ignore_recent_restage) {
            
                // Get the last restage time
                result = await exec('cf curl -X GET "/v3/apps/' + app_guid);
                let app_json = JSON.parse(result.stdout.split("\n")[0]);
                let app_updated_at = app_json.updated_at;
                let now = new Date();
                let last_restage_date = new Date(app_updated_at);
                let diff = now - last_restage_date;
                let diff_hours = diff / (1000 * 60 * 60);
                if (diff_hours < 24) {
                    console.log(app_name + " was restarted in the last 24 hours. Skipping...");
                    continue;
                }

            }

            apps.push({
                "name": app_name,
                "value": {
                    "org": org,
                    "space": space,
                    "app": app_name,
                    "state": app_state,
                    "guid": app_guid
                },
                //"disabled": app_info[1] == "stopped"
            });
        }

        apps.push(new Separator());

    }

    // Check if there are apps to restage
    if (apps.length == 0) {
        console.log("\nNo apps to restage.");
        return;
    }

    // Select the apps
    const selected_apps = await checkbox({
        message: 'Select the apps',
        choices: apps,
    });

    for (let i = 0; i < selected_apps.length; i++) {

        let app_org = selected_apps[i].org;
        let app_space = selected_apps[i].space;
        let app_name = selected_apps[i].app;
        let app_state = selected_apps[i].state;
        let app_guid = selected_apps[i].guid;

        await exec('cf target -o ' + app_org + ' -s ' + app_space);
        if (app_state == "started") {

            console.log("\n" + app_name + " is started. Restaging...");
            result = await exec('cf restage ' + app_name + ' --no-wait');
            console.log(result.stdout);

        } else {

            // When app is in stopped state, we create a build and set the
            // new droplet so that we dont need to start, restage and stop it.
            // Reference: https://v3-apidocs.cloudfoundry.org/version/3.141.0/index.html#restage
            console.log("\n" + app_name + " is stopped. Creating build...");

            // Get package guid
            result = await exec('cf curl -X GET "/v3/packages?app_guids=' + app_guid + '&order_by=-created_at&states=READY"');
            let package_json = JSON.parse(result.stdout.split("\n")[0]);
            let package_guid = package_json.resources[0].guid;

            // Create build
            result = await exec('cf curl -X POST "/v3/builds" -d "{ \\"package\\": { \\"guid\\": \\"' + package_guid + '\\" } }"');
            let build_json = JSON.parse(result.stdout.split("\n")[0]);
            let build_guid = build_json.guid;

            // Get build state
            let build_state = "";
            do {
                result = await exec('cf curl -X GET "/v3/builds/' + build_guid + '"');
                build_json = JSON.parse(result.stdout.split("\n")[0]);
                build_state = build_json.state;
                console.log("Build state: " + build_state);
                await new Promise(r => setTimeout(r, 5000));
            } while (build_state == "STAGING");

            // Set the new droplet
            let droplet_guid = build_json.droplet.guid;
            result = await exec('cf curl -X PATCH "/v3/apps/' + app_guid + '/relationships/current_droplet" -d "{ \\"data\\": { \\"guid\\": \\"' + droplet_guid + '\\" } }"');

        }

    }

    console.log("\nExecution completed.");

}
tanzu_restage();