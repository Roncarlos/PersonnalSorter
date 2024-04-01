const Tesseract = require('tesseract.js');
const fs = require('fs');
const path = require('path');

const { OpenAI } = require('openai');
const openai = new OpenAI({
    baseURL: "http://localhost:1234/v1",
    apiKey: "lm-studio"
});

const { readPdfPages } = require('pdf-text-reader');


const toProcessFolder = './toProcess';
const outputFolder = './output';

const existingGroups = [];
const existingSubGroups = [];



(async () => {

    const worker = await Tesseract.createWorker({
        // logger: m => console.log(m)
    });

    /**
     * 
     * @param {string[]} files 
     */
    async function handleAllFiles(files) {
        // For each file in ./images folder
        for (const file of files) {

            console.log('Handling file ' + file + '...');
            await handleFile(file);
        }
    }

    async function handleFile(file, tries = 0) {
        // Recognize text in the image
        // const { data: { text } } = await worker.recognize(`${toProcessFolder}/${file}`);

        const text = await getTextFromFile(file);

        // Save the text in ./output folder with the same name as the image .txt
        try {
            const resultFromLLM = await askTitleFromChatGpt(text);

            await updateGroupsAndSubGroups(resultFromLLM);

            await moveToFinalFolders(file, resultFromLLM);

        } catch (err) {
            console.log('Unable to write file: ' + err);
            if (tries < 3) {
                console.log('Retrying... (try ' + (tries + 1) + ')');
                await handleFile(file, tries + 1);
            } else {
                console.log('Failed to write file ' + file + ' after 3 tries. Skipping file.');
            }
        }

    }

    /**
     * 
     * @param {string} file
     * @param {{filename: string, group: string, subgroup: string}} resultFromLLM
     */
    async function moveToFinalFolders(file, resultFromLLM) {

        const fileExtension = file.split('.').pop().toLowerCase();

        // Create group and subgroup folders if they don't exist
        if (!fs.existsSync(`${outputFolder}/${resultFromLLM.group}`)) {
            fs.mkdirSync(`${outputFolder}/${resultFromLLM.group}`);
        }

        if (!fs.existsSync(`${outputFolder}/${resultFromLLM.group}/${resultFromLLM.subgroup}`)) {
            fs.mkdirSync(`${outputFolder}/${resultFromLLM.group}/${resultFromLLM.subgroup}`);
        }

        // Move file to group/subgroup folder
        fs.copyFileSync(`${toProcessFolder}/${file}`, `${outputFolder}/${resultFromLLM.group}/${resultFromLLM.subgroup}/${resultFromLLM.filename}.${fileExtension}`);

        // Delete file from processed folder
        fs.unlinkSync(`${toProcessFolder}/${file}`);
    }

    async function updateGroupsAndSubGroups(jsonResultObject) {
        if (!existingGroups.includes(jsonResultObject.group)) {
            existingGroups.push(jsonResultObject.group);
        }

        if (!existingSubGroups.includes(jsonResultObject.subgroup)) {
            existingSubGroups.push(jsonResultObject.subgroup);
        }

    }

    async function initializeGroupsAndSubGroups() {

        // Get groups => folders in output folder

        // Get subgroups => folders in groups folders

        const listOfFolders = fs.readdirSync(outputFolder);

        for (const folder of listOfFolders) {

            // Check if is a folder
            if (!fs.lstatSync(`${outputFolder}/${folder}`).isDirectory()) {
                continue;
            }

            existingGroups.push(folder);

            const subGroups = fs.readdirSync(`${outputFolder}/${folder}`);

            for (const subGroup of subGroups) {
                // Check if is a folder
                if (!fs.lstatSync(`${outputFolder}/${folder}/${subGroup}`).isDirectory()) {
                    continue;
                }

                existingSubGroups.push(subGroup);
            }

        }



    }

    /**
     * 
     * @param {string} file 
     * @returns 
     */
    async function getTextFromFile(file) {

        console.log('Getting text from file ' + file + '...');

        const filenameExtension = file.split('.').pop().toLowerCase();

        // if (file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg')) {
        if (['png', 'jpg', 'jpeg'].includes(filenameExtension)) {
            console.log('Type: image');
            return (await worker.recognize(`${toProcessFolder}/${file}`)).data.text;
        } else if (['txt'].includes(filenameExtension)) {
            console.log('Type: text');
            return fs.readFileSync(`${toProcessFolder}/${file}`, 'utf8');
        } else if (['pdf'].includes(filenameExtension)) {
            console.log('Type: pdf');
            // Convert pdf to text
            const pdfResult = await readPdfPages({
                url: `${toProcessFolder}/${file}`,
            });
            // Concat each pages
            const text = pdfResult.map(page => page.lines.join("\r\n")).join(' ');
            return text;
        }

        return '';
    }

    async function askTitleFromChatGpt(text) {

        const systemPrompt = `Vous allez avoir un texte extrait d'une image, donner un nom de fichier en rapport avec ce texte, ainsi que le groupe et le sous-groupe correspondant.
Le nom du fichier doit être court et précis et dans le format suivant: 'nom-du-fichier_date' où la date correspond à une date explicite extraite du texte, et si aucune date n'est trouvée ou que celle-ci ne correspond pas à une date logique, vous pouvez laisser le champ vide.
Le format de la date doit être 'AAAA-MM-JJ' (année-mois-jour) ou 'AAAA-MM' (année-mois) ou 'AAAA' (année).
Le contenu du texte peut être imparfait, prends en compte les erreurs possibles.
Le groupe correspond à une catégorie générale, et le sous-groupe à une catégorie plus spécifique.
Liste des groupes existants (pour exemple): "${existingGroups.join(', ')}". 
Liste des sous-groupes existants (pour exemple): "${existingSubGroups.join(', ')}".
La classification doit être la plus précise possible, choisi un groupe et un sous-groupe qui correspondent bien au texte.
Si aucun groupe ou sous-groupe ne correspond, vous devez en créer un nouveau.
C'est extrêmement important pour la classification des fichiers, donc si vous doutez, vous devez recréer un groupe ou sous-groupe.
Utilise exclusivement du français pour le nom des groupes et sous-groupes.
Réponds avec un json de la forme: { "filename": "nom-du-fichier", "group": "groupe", "subgroup": "sous-groupe" }.`;

        const userPrompt = text;

        const completion = await openai.chat.completions.create({
            model: "bartowski/c4ai-command-r-v01-GGUF/c4ai-command-r-v01-Q3_K_L.gguf",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            max_tokens: -1,
            temperature: 0.7,
        });

        const jsonObject = getFixedJson(completion.choices[0].message.content);

        return {
            filename: getFixedFilename(jsonObject.filename),
            group: jsonObject.group,
            subgroup: jsonObject.subgroup
        }
    }

    function getFixedJson(stringFromLLM) {

        try {
            return JSON.parse(stringFromLLM);
        } catch {
            console.log('Error parsing JSON from LLM. Trying to fix it...');
        }

        const almostJson = stringFromLLM;

        // it's a ```json``` string format so we remove the ```json and ``` part (first line and last line)
        const fixedJson = almostJson.split('\n').slice(1, -1).join('\n');

        return JSON.parse(fixedJson);
    }

    function getFixedFilename(filename) {
        // remove extension if present
        filename = filename.replace(/\.[^/.]+$/, "");
        return filename;
    }


    (async () => {
        await worker.loadLanguage('fra');
        await worker.initialize('fra');

        // Read all files names and path in ./images folder

        const directoryPath = path.join(__dirname, toProcessFolder);

        await initializeGroupsAndSubGroups();

        try {
            console.log('Reading files in ' + directoryPath + '...');
            const files = fs.readdirSync(directoryPath);
            await handleAllFiles(files);
        } catch (err) {
            console.log('Unable to scan directory: ' + err);
        }

        await worker.terminate();
    })();

})();